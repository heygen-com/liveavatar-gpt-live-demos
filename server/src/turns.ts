/**
 * Turn projection over GPT-Live v3 transcript fragments.
 *
 * v3 exposes only timed transcript deltas (`session.input_transcript.delta`,
 * `session.output_transcript.delta`: text + `start_ms`/`end_ms` on the session
 * timeline, 200ms frames, empty frames omitted). There are no turn events and
 * no speech-detection event. The UI, the lesson-card push, the review break and
 * the barge-in watch all want turns, so this rebuilds them the way OpenAI's
 * guide suggests: group same-speaker fragments, close a turn on a gap.
 *
 * Two gap clocks, both needed:
 *  - the session timeline (`start_ms - lastEndMs`): correct even when the
 *    network delivers fragments in a burst;
 *  - wall clock (idle timer): the only way to *finish* a turn when no further
 *    fragment ever arrives (the speaker simply stopped).
 *
 * User and assistant turns are tracked independently and may overlap — that is
 * full-duplex. A "mm-hmm" opens a user turn; whether it is an interruption is
 * decided downstream (session.ts), never here.
 */

import type { Turn } from "../../shared/messages";

// Quiet this long ends a turn. Sentence pauses run 300–700ms; a pause while
// the live model waits on a delegation can run longer and will split the
// assistant's line in two — cosmetic in the UI, harmless to the card push,
// and exactly the "between beats" moment the review break wants.
export const TURN_GAP_MS = 1500;

type Role = Turn["role"];

interface OpenTurn {
  id: string;
  text: string;
  endMs: number | null;
  timer: NodeJS.Timeout;
}

export interface TurnSink {
  onTurn(turn: Turn): void;
  /** A user turn just opened — the barge-in signal. */
  onUserTurnStarted(): void;
}

export class TurnProjector {
  private readonly open: Record<Role, OpenTurn | null> = {
    user: null,
    assistant: null,
  };
  private seq = 0;

  constructor(
    private readonly sink: TurnSink,
    private readonly gapMs: number = TURN_GAP_MS,
  ) {}

  fragment(
    role: Role,
    delta: string,
    startMs: number | null,
    endMs: number | null,
  ): void {
    if (!delta) return;
    let cur = this.open[role];
    // Timeline gap: the speaker paused longer than a turn survives, but the
    // fragments arrived close together (burst) so the idle timer never fired.
    if (
      cur &&
      cur.endMs !== null &&
      startMs !== null &&
      startMs - cur.endMs > this.gapMs
    ) {
      this.close(role);
      cur = null;
    }
    if (!cur) {
      this.seq += 1;
      cur = {
        id: `${role}_${this.seq}`,
        text: "",
        endMs: null,
        timer: setTimeout(() => this.close(role), this.gapMs),
      };
      this.open[role] = cur;
      if (role === "user") this.sink.onUserTurnStarted();
    } else {
      clearTimeout(cur.timer);
      cur.timer = setTimeout(() => this.close(role), this.gapMs);
    }
    // Deltas are joined raw, like OpenAI's reference client: the service
    // includes its own spacing, and Japanese has none to add.
    cur.text += delta;
    if (endMs !== null) cur.endMs = Math.max(cur.endMs ?? 0, endMs);
    this.sink.onTurn({ id: cur.id, role, text: cur.text, done: false });
  }

  /** Finish the open turn for a role (no-op if none). */
  close(role: Role): void {
    const cur = this.open[role];
    if (!cur) return;
    clearTimeout(cur.timer);
    this.open[role] = null;
    this.sink.onTurn({ id: cur.id, role, text: cur.text, done: true });
  }

  dispose(): void {
    for (const role of ["user", "assistant"] as Role[]) {
      const cur = this.open[role];
      if (cur) clearTimeout(cur.timer);
      this.open[role] = null;
    }
  }
}
