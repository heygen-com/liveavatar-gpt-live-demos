/**
 * The heads-up poker simulator — the orchestrator's single source of game
 * truth. Cards, pot, stacks, and outcomes exist only here; the models relay
 * the player's decisions and narrate the state this engine hands back.
 *
 * Deliberately small for v1:
 *  - Both players start every hand at 100bb (the running score carries the
 *    session's win/loss across hands).
 *  - The player is always the big blind and acts on every street after the
 *    opponent's forced opener — so every decision point in a hand is the
 *    user's, which is the whole coaching loop.
 *  - The opponent is a probabilistic bot that never re-raises. It does not
 *    look at its own cards (a coaching demo needs streets and showdowns, not
 *    a good villain) — which also means its hidden hand can never leak
 *    through its behavior.
 *  - One raise per street: after the user bets/raises, the bot calls or
 *    folds, and the street closes.
 */

// ── cards ─────────────────────────────────────────────────────────────────────

const RANKS = "23456789TJQKA"; // index = strength - 2
const SUITS = "shdc";

/** "As", "Td", "3h" — rank char + suit char (see shared/messages.ts). */
export type Card = string;

export function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  // Fisher–Yates.
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

const rankOf = (c: Card): number => RANKS.indexOf(c[0]!) + 2;
const suitOf = (c: Card): string => c[1]!;

// ── 7-card evaluator ──────────────────────────────────────────────────────────

const CATEGORY_NAMES = [
  "high card",
  "a pair",
  "two pair",
  "three of a kind",
  "a straight",
  "a flush",
  "a full house",
  "four of a kind",
  "a straight flush",
] as const;

interface HandValue {
  /** [category, tiebreakers...] — compare lexicographically, higher wins. */
  rank: number[];
  name: string;
}

/** Best 5-card value out of 5 exact cards. */
function evaluate5(cards: Card[]): number[] {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const isFlush = cards.every((c) => suitOf(c) === suitOf(cards[0]!));

  // Straight: 5 distinct descending ranks, with the wheel (A-5) special-cased.
  const distinct = [...new Set(ranks)];
  let straightHigh = 0;
  if (distinct.length === 5) {
    if (distinct[0]! - distinct[4]! === 4) straightHigh = distinct[0]!;
    else if (distinct[0] === 14 && distinct[1] === 5 && distinct[4] === 2)
      straightHigh = 5; // A-2-3-4-5 plays as a five-high straight
  }

  // Group sizes: counts of each rank, ordered by (count, rank) desc — the
  // standard kicker ordering for pairs/trips/quads.
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || b[0] - a[0],
  );
  const shape = groups.map(([, n]) => n).join("");
  const ordered = groups.map(([r]) => r);

  if (isFlush && straightHigh) return [8, straightHigh];
  if (shape.startsWith("4")) return [7, ...ordered];
  if (shape.startsWith("32")) return [6, ...ordered];
  if (isFlush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (shape.startsWith("3")) return [3, ...ordered];
  if (shape.startsWith("22")) return [2, ...ordered];
  if (shape.startsWith("2")) return [1, ...ordered];
  return [0, ...ranks];
}

/** Best 5-of-7 hand: evaluate all 21 combinations, keep the max. */
export function evaluate7(cards: Card[]): HandValue {
  let best: number[] | null = null;
  for (let a = 0; a < 7; a++) {
    for (let b = a + 1; b < 7; b++) {
      const five = cards.filter((_, i) => i !== a && i !== b);
      const v = evaluate5(five);
      if (!best || compareRanks(v, best) > 0) best = v;
    }
  }
  return { rank: best!, name: CATEGORY_NAMES[best![0]!]! };
}

export function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ── game state ────────────────────────────────────────────────────────────────

export type Street = "preflop" | "flop" | "turn" | "river" | "hand_over";

/** Which part of the table just changed — mirrors PokerReveal on the wire. */
export type Reveal = "new_hand" | "flop" | "turn" | "river" | "opponent" | "update";

export interface Snapshot {
  handNumber: number;
  playerHand: [Card, Card];
  board: Card[];
  /** null until showdown — never expose it earlier, anywhere. */
  opponentHand: [Card, Card] | null;
  potBb: number;
  playerStackBb: number;
  opponentStackBb: number;
  toCallBb: number;
  scoreBb: number;
  street: Street;
  statusText: string;
}

export interface ActionOutcome {
  /** The final table state after everything the action set in motion. */
  snapshot: Snapshot;
  /** Which cards the client should animate. */
  reveal: Reveal;
  /** What happened, in dealer's English — the tool result the model narrates. */
  narration: string;
  handOver: boolean;
}

export type PlayerAction = "bet" | "check_call" | "fold";

const START_STACK = 100;
const SMALL_BLIND = 0.5;
const BIG_BLIND = 1;

// Bot policy knobs — probabilities, not strategy. See the header comment.
const BOT_PREFLOP_RAISE_P = 0.3;
const BOT_PREFLOP_RAISE_TO = 3;
const BOT_STAB_P = 0.3; // bets when checked to
const BOT_FOLD_TO_BET_P = 0.25;

const half = (n: number): number => Math.round(n * 2) / 2;

export class PokerGame {
  handNumber = 0;
  scoreBb = 0;

  private deck: Card[] = [];
  private playerHand: [Card, Card] | null = null;
  private oppHand: [Card, Card] | null = null;
  private oppRevealed = false;
  private board: Card[] = [];
  private street: Street = "hand_over";
  private potBb = 0;
  private playerStack = START_STACK;
  private oppStack = START_STACK;
  private toCall = 0;
  private statusText = "Say “deal” to start a hand.";

  get handInProgress(): boolean {
    return this.street !== "hand_over";
  }

  /** Shuffle, post blinds, run the bot's forced preflop opener. */
  startHand(): ActionOutcome {
    this.handNumber += 1;
    this.deck = freshDeck();
    this.playerHand = [this.deck.pop()!, this.deck.pop()!];
    this.oppHand = [this.deck.pop()!, this.deck.pop()!];
    this.oppRevealed = false;
    this.board = [];
    this.street = "preflop";
    this.playerStack = START_STACK - BIG_BLIND;
    this.oppStack = START_STACK - SMALL_BLIND;
    this.potBb = BIG_BLIND + SMALL_BLIND;

    // The bot is the small blind / button and opens every hand, so the first
    // decision is always the user's.
    let narration: string;
    if (Math.random() < BOT_PREFLOP_RAISE_P) {
      const add = BOT_PREFLOP_RAISE_TO - SMALL_BLIND;
      this.oppStack -= add;
      this.potBb += add;
      this.toCall = BOT_PREFLOP_RAISE_TO - BIG_BLIND;
      this.statusText = `Opponent raises to ${BOT_PREFLOP_RAISE_TO}bb`;
      narration =
        `Hand #${this.handNumber} dealt. You are the big blind with ` +
        `${this.handWords()}. Opponent raises to ${BOT_PREFLOP_RAISE_TO}bb — ` +
        `${this.toCall}bb to call.`;
    } else {
      const add = BIG_BLIND - SMALL_BLIND;
      this.oppStack -= add;
      this.potBb += add;
      this.toCall = 0;
      this.statusText = "Opponent limps in";
      narration =
        `Hand #${this.handNumber} dealt. You are the big blind with ` +
        `${this.handWords()}. Opponent limps; you can check or raise.`;
    }
    return this.outcome("new_hand", narration, false);
  }

  /**
   * Apply the user's decision and everything it sets in motion — the bot's
   * response, street advances, showdown — and return the settled result.
   * Exactly one outcome per decision: by the time this returns, it is either
   * the user's action again or the hand is over.
   */
  act(action: PlayerAction, amountBb?: number): ActionOutcome {
    if (!this.handInProgress) {
      throw new Error("no hand in progress");
    }
    const beats: string[] = [];

    if (action === "fold") {
      beats.push("You fold.");
      return this.settle(null, beats);
    }

    if (action === "check_call") {
      if (this.toCall > 0) {
        const paid = Math.min(this.toCall, this.playerStack);
        this.playerStack -= paid;
        this.potBb += paid;
        this.toCall = 0;
        beats.push(`You call ${paid}bb.`);
        return this.advance(beats);
      }
      beats.push("You check.");
      // Checked to the bot: it stabs sometimes, otherwise the street closes.
      // Preflop a check behind the limp just closes the action.
      if (this.street !== "preflop" && Math.random() < BOT_STAB_P) {
        const bet = Math.min(half(this.potBb * 0.66), this.oppStack);
        if (bet > 0) {
          this.oppStack -= bet;
          this.potBb += bet;
          this.toCall = bet;
          beats.push(`Opponent bets ${bet}bb. Action on you.`);
          this.statusText = `Opponent bets ${bet}bb`;
          return this.outcome("update", beats.join(" "), false);
        }
      }
      // Preflop the bot already acted (the limp) — a check just closes the
      // street; postflop a check-through means the bot checked behind.
      if (this.street !== "preflop") beats.push("Opponent checks.");
      return this.advance(beats);
    }

    // bet / raise: `amountBb` is the chips the user pushes in on this street.
    const minBet = this.toCall > 0 ? this.toCall + BIG_BLIND : BIG_BLIND;
    const fallback =
      this.toCall > 0
        ? this.toCall * 3
        : this.street === "preflop"
          ? 3
          : half(this.potBb * 0.66);
    let chips = half(typeof amountBb === "number" ? amountBb : fallback);
    // The stack cap wins over the raise minimum: a stack too short to raise
    // legally goes all in instead of going negative.
    chips = Math.min(Math.max(chips, minBet), this.playerStack);
    const wasFacing = this.toCall;
    this.playerStack -= chips;
    this.potBb += chips;
    const outstanding = Math.max(0, chips - this.toCall); // what the bot now owes
    this.toCall = 0;
    beats.push(
      this.toCallWordFor(chips, wasFacing) +
        (this.playerStack === 0 ? " You are all in." : ""),
    );
    // An all-in "raise" that couldn't cover the price is really a call — the
    // bot has nothing to respond to.
    if (outstanding === 0) return this.advance(beats);

    if (Math.random() < BOT_FOLD_TO_BET_P) {
      beats.push("Opponent folds.");
      return this.settle("player", beats);
    }
    const botPaid = Math.min(outstanding, this.oppStack);
    this.oppStack -= botPaid;
    this.potBb += botPaid;
    beats.push("Opponent calls.");
    return this.advance(beats);
  }

  /** Full table state; what the wire message and the tool results carry. */
  snapshot(): Snapshot {
    return {
      handNumber: this.handNumber,
      playerHand: this.playerHand ?? ["??", "??"],
      board: [...this.board],
      opponentHand: this.oppRevealed ? this.oppHand : null,
      potBb: this.potBb,
      playerStackBb: this.playerStack,
      opponentStackBb: this.oppStack,
      toCallBb: this.toCall,
      scoreBb: this.scoreBb,
      street: this.street,
      statusText: this.statusText,
    };
  }

  /**
   * One-line state summary for model context — the ground truth both models
   * coach from. Never includes the opponent's cards before showdown.
   */
  describe(): string {
    if (!this.handInProgress)
      return (
        `No hand in progress. Session score: ${signed(this.scoreBb)}bb over ` +
        `${this.handNumber} hand${this.handNumber === 1 ? "" : "s"}.`
      );
    return (
      `Hand #${this.handNumber}, ${this.street}. Your cards: ${this.handWords()}. ` +
      `Board: ${this.board.length ? this.board.join(" ") : "(none yet)"}. ` +
      `Pot ${this.potBb}bb, to call ${this.toCall}bb, stacks you ${this.playerStack}bb / ` +
      `opponent ${this.oppStack}bb. Session score ${signed(this.scoreBb)}bb.`
    );
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Betting closed on this street: deal the next one or go to showdown. */
  private advance(beats: string[]): ActionOutcome {
    // Someone is all in: no more decisions exist — run the board out.
    const allIn = this.playerStack === 0 || this.oppStack === 0;
    const ranOut = allIn && this.board.length < 5;

    if (this.street === "river" || (allIn && this.dealRunout())) {
      return this.showdown(beats, ranOut);
    }
    if (this.street === "preflop") {
      this.board.push(this.deck.pop()!, this.deck.pop()!, this.deck.pop()!);
      this.street = "flop";
    } else if (this.street === "flop") {
      this.board.push(this.deck.pop()!);
      this.street = "turn";
    } else {
      this.board.push(this.deck.pop()!);
      this.street = "river";
    }
    this.toCall = 0;
    beats.push(
      `${cap(this.street)}: ${this.board.join(" ")}. Pot ${this.potBb}bb. Action on you.`,
    );
    this.statusText = `Pot ${this.potBb}bb — your action`;
    return this.outcome(this.street as Reveal, beats.join(" "), false);
  }

  /** Deal any remaining board cards; returns true (for the all-in branch). */
  private dealRunout(): boolean {
    while (this.board.length < 5) this.board.push(this.deck.pop()!);
    this.street = "river";
    return true;
  }

  private showdown(beats: string[], ranOut: boolean): ActionOutcome {
    if (ranOut) beats.push(`All in — board runs out ${this.board.join(" ")}.`);
    this.oppRevealed = true;
    const you = evaluate7([...this.playerHand!, ...this.board]);
    const opp = evaluate7([...this.oppHand!, ...this.board]);
    const cmp = compareRanks(you.rank, opp.rank);
    beats.push(
      `Showdown: opponent shows ${this.oppHand!.join(" ")}. ` +
        `You have ${you.name}, opponent has ${opp.name}.`,
    );
    return this.settle(cmp > 0 ? "player" : cmp < 0 ? "opponent" : "split", beats);
  }

  /**
   * End the hand: award the pot, fold the result into the running score.
   * `winner: null` means the user folded (the pot goes to the opponent, but
   * without a showdown).
   */
  private settle(
    winner: "player" | "opponent" | "split" | null,
    beats: string[],
  ): ActionOutcome {
    const pot = this.potBb;
    if (winner === "player") {
      this.playerStack += pot;
      beats.push(`You win the ${pot}bb pot.`);
      this.statusText = `You win ${pot}bb`;
    } else if (winner === "split") {
      this.playerStack += pot / 2;
      this.oppStack += pot / 2;
      beats.push(`Chopped pot — ${pot / 2}bb back each.`);
      this.statusText = "Split pot";
    } else {
      this.oppStack += pot;
      const how = winner === null ? "You fold — opponent" : "Opponent";
      beats.push(`${how} takes the ${pot}bb pot.`);
      this.statusText = `Opponent wins ${pot}bb`;
    }
    this.potBb = 0;
    this.toCall = 0;
    const delta = this.playerStack - START_STACK;
    this.scoreBb = half(this.scoreBb + delta);
    this.street = "hand_over";
    beats.push(
      `That's ${signed(delta)}bb on the hand, ${signed(this.scoreBb)}bb for the session.`,
    );
    // Showdowns reveal the villain's cards on screen; folds just update.
    const reveal: Reveal = this.oppRevealed ? "opponent" : "update";
    return this.outcome(reveal, beats.join(" "), true);
  }

  private outcome(
    reveal: Reveal,
    narration: string,
    handOver: boolean,
  ): ActionOutcome {
    return { snapshot: this.snapshot(), reveal, narration, handOver };
  }

  private handWords(): string {
    return this.playerHand ? this.playerHand.join(" ") : "??";
  }

  private toCallWordFor(chips: number, wasFacing: number): string {
    return wasFacing > 0
      ? `You raise, putting in ${chips}bb.`
      : `You bet ${chips}bb.`;
  }
}

const cap = (s: string): string => s[0]!.toUpperCase() + s.slice(1);
const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
