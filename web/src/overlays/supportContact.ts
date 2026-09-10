/**
 * The `support_contact` widget: the hand-off card, for asks that need a human
 * — refunds, billing disputes, custom avatar approval, account trouble — or
 * that the agent genuinely cannot answer.
 *
 * This is the one widget that is NOT a Hyperframes composition, and the
 * reason is the click. A composition plays inside the player's iframe, which
 * is sandboxed `allow-scripts allow-same-origin` — no `allow-popups`, no
 * `allow-top-navigation-by-user-activation` — so a `mailto:` inside it is
 * inert; and `#overlay-player` is `pointer-events: none`, so the click never
 * reaches it in the first place. A card whose whole job is to be clicked has
 * to live in the host page. It is real DOM appended to #stage.
 *
 * Two consequences worth knowing:
 *   - No timeline, so no `ended` event and no self-clearing. It stays until
 *     the user dismisses it or the next widget calls `hideAll`. That is right
 *     for this card: an email the user has not sent yet should not evaporate.
 *   - The avatar stays full-frame behind it (no PiP), so the card keeps to
 *     the lower-left and leaves the face clear.
 *
 * Every value is model-adjacent and set with textContent. The mailto is
 * assembled with encodeURIComponent, so a subject or body carrying `&` or a
 * newline cannot rewrite the URL's own parameters.
 */
import type { SupportContactProps } from "../../../shared/messages";
import type { OverlayContext } from "./index";

let card: HTMLAnchorElement | null = null;

export function hideSupportContact(): void {
  card?.remove();
  card = null;
}

export function showSupportContact(ctx: OverlayContext, props: SupportContactProps): void {
  hideSupportContact(); // one card at a time; a second ask replaces the first

  const href =
    `mailto:${encodeURIComponent(props.email)}` +
    `?subject=${encodeURIComponent(props.subject)}` +
    `&body=${encodeURIComponent(props.body)}`;

  const el = document.createElement("a");
  el.id = "support-card";
  el.href = href;
  // The user's mail client is not this page — opening it in place would tear
  // down the live session (and its billing) behind them.
  el.target = "_blank";
  el.rel = "noopener";
  el.setAttribute("aria-label", `Email ${props.email} about ${props.subject}`);

  const title = document.createElement("div");
  title.className = "sc-title";
  title.textContent = props.title;

  const note = document.createElement("div");
  note.className = "sc-note";
  note.textContent = props.note;

  const address = document.createElement("div");
  address.className = "sc-email";
  address.textContent = props.email;

  // Static label over the preview. The model's subject line still travels in
  // the mailto — it just isn't echoed here.
  const label = document.createElement("div");
  label.className = "sc-subject";
  label.textContent = "Email content";

  const preview = document.createElement("div");
  preview.className = "sc-preview";
  // The pre-filled body, minus the signature line the server appends — the
  // preview is there to show the user their own words came through.
  preview.textContent = props.body.split("\n\n—")[0] ?? props.body;

  const dismiss = document.createElement("button");
  dismiss.className = "sc-dismiss";
  dismiss.type = "button";
  dismiss.textContent = "✕";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.addEventListener("click", (e) => {
    // Inside an <a>: without both, dismissing would also open the mail client.
    e.preventDefault();
    e.stopPropagation();
    hideSupportContact();
  });

  el.append(title, note, label, preview, address, dismiss);
  ctx.stage.appendChild(el);
  card = el;

  // One frame later so the entry transition has a state to animate from.
  requestAnimationFrame(() => el.classList.add("visible"));
}
