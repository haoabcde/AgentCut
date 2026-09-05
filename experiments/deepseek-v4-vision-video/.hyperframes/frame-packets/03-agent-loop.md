# Frame packet: 03-agent-loop

## Project inputs

- Project: /Users/hao/Developer/AgentCut/experiments/deepseek-v4-vision-video
- Design tokens: /Users/hao/Developer/AgentCut/experiments/deepseek-v4-vision-video/frame.md
- RULES_DIR: /Users/hao/.agents/skills/hyperframes-animation/rules

## Assigned storyboard block

## Frame 3 — 看见，然后行动

- scene: 图片、截图和图表进入视觉编码器，经过模型核心后分流到浏览器、代码和文件工具
- voiceover: "它能读截图、图表和图片，再继续调用工具完成任务。重点不是会看图，而是看完之后还能行动。"
- duration: 10s
- poster: 6.0s
- transition_in: crossfade
- status: outline
- src: compositions/frames/03-agent-loop.html
- type: feature_showcase
- persuasion: Causal chain + Distillation
- beat: comprehension + aha
- blueprint: agent-progress-theater (Adapt)
- rules: svg-path-draw
- focal: 从 IMAGE INPUT 穿过 VISION CORE 到 BROWSER / CODE / FILE 的行动流水线
- roles: 视觉核心与行动路径 = foreground subject · 三类输入与三类工具 = supporting · 扫描栅格 = background
- sfx: scan-short, confirm-soft

narrativeRole: 解释“多模态 Agent”不是视觉问答，而是视觉理解进入工具调用闭环。
keyMessage: 图像理解只是输入，真正的 Agent 价值来自理解之后继续操作工具。

Adapt: 保留机器“正在工作并交付结果”的 signature move；去掉 UI、光标和圆角面板，用抽象节点、状态行和完成回执表达真正的多模态 Agent 流程。
Scene 1 (0.0–2.6s): SCREENSHOT、CHART、IMAGE 三个竖向输入条只在被旁白点名时依次亮起，沿细线汇入中央 VISION CORE；layered-depth 垂直路径占画面约 55%。动作使用 node stagger 的平滑无弹跳寄存器与 connector self-draw。
Scene 2 (2.6–6.5s): 中央核心显示有限帧扫描弧与状态词 “SEE → REASON”；状态槽按旁白切换，脉冲是叙事状态而非装饰，完成后立即停止。动作使用 state swap 与有限 SVG internals。
Scene 3 (6.5–8.8s): “调用工具”出现时，输出路径向上方安全区内的 BROWSER、CODE、FILE 三站依次自绘，每一站收到一次青色完成标记；竖向全宽流水线保持单一视觉焦点。动作使用 path draw 与 receipt mutation。
Scene 4 (8.8–10.0s): 巨型短句 “看完 / 还能行动”在核心上方分两拍落定，所有工作状态停下，工具闭环保持静止持读。

## Selected blueprint: agent-progress-theater

# agent-progress-theater — Agent Progress Theater

**intent**: Agent work performed as WORKING-STATE theater — a short trigger beat hands the frame to the machine, which then visibly _works_: loaders spin, status phrases swap, dots pulse, counters tick — before the receipt arrives as a card whose rows cascade in and CHANGE STATE (badges flip to checks, labels strike through, severity pills read out), or as a conversation thread building message-by-message onto a camera push-in payoff. The subject is the machine performing labor over time. It is NOT a typed prompt awaiting output (no prompt/input is ever typed — the trigger is a click, a menu choice, or an already-running scan); NOT `cursor-ui-demo` (at most ONE igniting click here, then the cursor exits and the UI performs itself); NOT `grid-card-assemble` (rows there assemble into a static enumeration and hold — rows here are alive: they arrive as agent output and then MUTATE, checking off one by one while the viewer watches).

**roles served**

- Key_Feature (from `agent-progress-theater`): when the feature is the agent doing multi-step work (build a plan / scan a repo / fix a vulnerability / handle infra for you) and the proof is status theater — a loader lockup with a typed label, status couplets swapping under an `[accent]` spinner, then a checklist/findings card that populates and checks off in front of the viewer.
- Key_Feature (from `message-thread-payoff`): when the agent's work lives inside a conversation or automation thread — user/agent bubbles and tool-call/reply cards popping in sequence, the working state carried by pulsing loading dots or rapidly ticking diff counters, resolved by ONE camera push-in tight on the confirmation line (`[reaction pill]`, "Sent using `[@Bot]`", a thank-you bubble).

**duration**: 4.2–11.6s (short members are a single card-and-check-off or thread beat at ~4–5s; long members chain trigger → interstitial → status swaps → receipt card at ~9–12s; thread payoff spans 4.2–9.1s)

**shot structure** (a warm flat canvas — `[off-white / warm beige / near-white bg]`, optional `[faint grid / dot-grid / wavy-line]` texture; white rounded cards with soft drop shadows; ONE `[working accent]` color reserved for the machine (spinner, status words, active step) and one `[done color]` for completion (checks, "Completed"); camera static or ONE slow move — motion is overwhelmingly element-level springs, staggers, and state flips. Two folded sub-shapes — **(A) checklist/findings theater** and **(B) message-thread payoff**.)

- **Scene 1 (0.0–~1.5s) — the trigger.** Something asks the machine to work, in ONE beat:
  - _Variant — option menu (A)_: a centered white pill card poses `[the question]`; it SPRINGS open downward into a rounded menu — `[3–4 option rows]` fade/slide in staggered, each with a number badge. A cursor enters, hover-dances between rows (a pale `[hover fill]` highlight follows it), and CLICKS the chosen row (~press-down spring); the whole menu scales down toward its center and fades out. This is the only cursor appearance in the shot.
  - _Variant — modal click (A)_: close-up of a white modal with `[Dismiss]` / `[action button]`; a hand cursor clicks the action (quick press-down spring); the modal fades away. Optionally followed by a serif `[interstitial line]` on the bare canvas — words land staggered, hold, fade out word-staggered as the bg swaps.
  - _Variant — already working (A)_: a `[Scan in progress]`-style state — a thin `[accent]` arc spinner rotating over a heading + body copy + a `[Starting…]` pill (cursor resting on it, motionless); only the spinner moves. The whole scene then rapidly scales up and fades — a push-through exit.
  - _Variant — workspace push-through (A)_: a rapid camera push-in THROUGH a multi-panel `[workspace: builder / editor / terminal]` — panels scale past the viewport edges and clear away to the bare canvas.
  - _Variant — thread opener (B)_: a `[user bubble]` spring-pops in ("`[the ask]`"), OR a stats card pops in whose green/red `[diff counters]` rapidly tick and settle — the automation's opening receipt.

- **Scene 2 (~1–4s) — the working state (the machine performs).** The frame belongs to the machine; nothing is clickable. Pick 1–3 working motifs and CHAIN them:
  - A loader lockup: a spinning `[accent asterisk / arc]` beside a `[working label]` typed on rapidly ("`Buildi` → `Building plan…`"), a left→right shimmer sweep passing through the letters; the spinner may momentarily morph asterisk↔dot and back.
  - Status couplets: 2–3 centered pairs — a dark `[action line]` over an `[accent status word]` ("Thinking…", "Noodling…") with its spinner — swapping via quick fades/slides at a steady cadence.
  - A `[scan/tool label]` types/expands rightward to its full string, then SHRINKS and DOCKS to the top-left as a fixed corner header (the canvas now belongs to what it produces).
  - A status heading flips tense as rows land beneath it ("Using `[Tool]`" → "Used `[Tool]`"), with a gently pulsing "Thinking" and gray meta-lines ("Exploring `[N]` files…") fading in below.
  - _Variant — thread machinery (B)_: the `[agent reply]` fades/slides up, then a monospace `[tool_call]` line appears beneath it — small icon + `[tool name]` + three pulsing loading dots; OR an instruction bubble scrolls into view (internal window scroll, frame static) followed by a `[brand logo]` pop-in beside a "Sending message…" row. **The pulse dies the instant the result lands** — dots vanish as the payload arrives.

- **Scene 3 (~2–4s) — the receipt cascades in (the payoff engine).** The work materializes as a card that BUILDS:
  - _Variant — checklist (A)_: a white `[Progress / summary]` pill or card SPRING-pops in with a bounce, then springs open downward (or the summary card glides UP as a taller `[findings]` panel expands beneath it). Rows cascade in one by one — slide-up + fade, staggered — each with `[number badge / severity pill]` + `[label]` + optional gray `[meta line]`. Then the STATE MUTATION runs: badges flip one by one from numbered outline to a solid `[done color]` circle + white checkmark (slight scale bounce), the checked label simultaneously strikes through and dims; pending items keep partially-drawn arc outlines animating. End the run mid-list — some items checked, some still numbered — the work is visibly _ongoing_.
  - _Variant — thread payload (B)_: the camera pushes in / pans down centering the `[tool_call]` line as a white payload card expands downward from it — 2–4 light monospace `[key: value]` lines fading in. Then the `[resolution message]` expands into place below (inline `[code chips]` and `[link]` coloring), OR a dark `[thread card]` scales up from a status row to DOMINATE the frame while the background darkens, its `[reply]` expanding into place under a "1 reply" divider.

- **Scene 4 (final ~1–2.5s) — resolve.** Two endings:
  - _Variant — hold / scroll (A)_: the finished (or mid-mutation) card stack holds static to the end, OR the viewport scrolls down the final card (fast in the last beat) revealing `[a second heading + numbered list]`, ending mid-list. A slow continuous zoom into the card may run underneath (the header drifts off the top of frame).
  - _Variant — payoff push-in (B)_: ONE camera push-in + pan-down lands tight on the payoff line — "`Sent using [@Bot]`" / the confirmation + `[thank-you bubble]` spring-in — then a `[reaction button]` springs into an active pill with bouncy overshoot and a count. The push eases into a gentle near-imperceptible drift and the clip ends on the close-up. No end card.

**motion vocabulary**: pill springs open downward into a menu/checklist · option rows fade/slide in staggered · cursor hover-dance (pale highlight fill follows the cursor between rows) · single igniting click with press-down spring · menu scale-down fade exit · modal fade-away · thin `[accent]` arc spinner rotation · spinning asterisk loader · asterisk↔dot morph · typed-on loader label with caret · left→right text shimmer sweep · serif interstitial with word-staggered fade in/out · status couplets swapping via quick fades/slides under an `[accent]` spinner · pulsing "Thinking" label · status heading tense flip (Using→Used) · label types/expands rightward then shrinks and docks as a corner header · scene scale-up/fade push-through exit · rapid camera push-in through a multi-panel workspace · slow continuous zoom into a card (header drifts off frame) · summary card spring pop with bounce · card glides up as a panel expands beneath it · anchored downward panel/payload expansion · rows stagger in (slide-up + fade) · badge flip from numbered outline to solid circle + white checkmark with scale bounce · strikethrough + dim on completion · partially-drawn arc outlines animating on pending items · severity-pill readouts (Critical / High) · viewport scroll down the final card · chat bubble spring scale-up pop-in · reply fade/slide-up · monospace tool-call line with three pulsing loading dots (dots die the instant the result lands) · payload card expands downward from the line · green/red diff counters rapid tick-and-settle · internal window scroll (frame static) · brand logo pop-in beside a status row · card scales up from a row to dominate the frame while the background darkens · reply message expands into place · inline code chips / link coloring · reaction button springs into an active pill with bouncy overshoot + count · camera push-in + pan-down centering the payoff · slight pull-back · gentle end drift · static hold.

**rule mapping**

- pill springs open downward into a menu / panel expands beneath a gliding card / payload card expands downward from a tool-call line → `anchored-layout-expand` (edge-anchored container growth: height-masked wrapper + inner counter-translate, container drawn at final size); spring flavor from `spring-pop-entrance`
- option rows / findings rows / task rows stagger in (slide-up + fade) → `spring-pop-entrance` (staggered-group form, ≤500ms cap) or `gsap-effects` (plain fade+translate stagger) — NOT `waterfall-entry` (its binary no-fade arrival law contradicts this dialect's soft fade/slide cascade)
- cursor glides to a row and clicks; hand cursor clicks the modal button → `cursor-click-ripple` (move + press) + `press-release-spring` (the button's press-down spring)
- pale hover-highlight fill following the cursor between rows → `gsap-effects` (a background fill translated row-to-row; no dedicated rule needed)
- menu scale-down fade exit / scene scale-up push-through exit / palette-for-window swap → `scale-swap-transition`
- thin arc spinner rotation / spinning asterisk loader → `svg-icon-enrichment` (rotating internal SVG parts via `setAttribute('transform','rotate(deg cx cy)')`; timeline-driven, finite)
- asterisk↔dot morph and back → `scale-swap-transition` (two elements morphing at the same center)
- typed-on loader label ("Building plan…") / scan label typing to its full string → `discrete-text-sequence` (+ `context-sensitive-cursor` for the caret)
- left→right shimmer sweep through the loader letters → `ambient-glow-bloom` (single-pass traveling sheen) or `css-marker-patterns` (highlight sweep) — pick sheen for light-on-text, marker for a drawn band
- serif interstitial word-staggered fade in/out; status couplets swapping on a cadence → `dynamic-content-sequencing` (phrase windows) + `discrete-text-sequence` (the whole-state swaps); per-word stagger via `gsap-effects`
- pulsing "Thinking" label / three pulsing loading dots (phase-offset) → `sine-wave-loop` (finite repeats; kill the tween at the resolve beat — see doctrine note)
- status heading tense flip (Using→Used) / gray meta-lines fading in / final-token snaps → `discrete-text-sequence`
- label shrinks and docks to the top-left as a fixed corner header → `gsap-effects` (plain scale + translate tween; no dedicated rule needed)
- rapid camera push-in through the multi-panel workspace → `viewport-change` (the push) + `multi-phase-camera` (phasing) + optional `motion-blur-streak` (velocity blur as panels clear the frame)
- slow continuous zoom into the receipt card (header drifts off top) → `multi-phase-camera` (steady-push phase) or `viewport-change`
- summary card / progress pill / chat bubble / brand logo / file chip spring pop-in → `spring-pop-entrance`
- summary card glides up as the findings panel expands beneath → `gsap-effects` (the glide) + `anchored-layout-expand` (the panel)
- badge flip: numbered outline → solid circle + white checkmark with scale bounce → `scale-swap-transition` (outline↔solid swap at same center) + `svg-path-draw` (checkmark draw-in) + `spring-pop-entrance` (the bounce); the pending→active→complete progression itself → `dynamic-content-sequencing` (a snap state machine, per cursor-ui-demo's workflow-approve-press precedent)
- strikethrough + dim on the checked label → `css-marker-patterns` (strike-through draw) + `gsap-effects` (opacity dim)
- partially-drawn arc outlines animating on pending items → `svg-path-draw` (partial dashoffset, held mid-draw)
- viewport scroll down the final card / internal window scroll under a static frame → `gsap-effects` (transform-only content translate inside a masked window) — use `viewport-change` only if the FRAME moves
- green/red diff counters rapid tick-and-settle → `counting-dynamic-scale` (numeric proxy count-up; suppress the scale-growth component — these tick at fixed size)
- dark thread card scales up from a row to dominate the frame → `card-morph-anchor` (row → full-frame morph + handoff) with the background darkening as a `gsap-effects` overlay fade
- reply message / resolution line expands into place → `spring-pop-entrance` (soft overshoot) or `anchored-layout-expand` for a true downward growth
- reaction button springs into an active pill with overshoot + count → `spring-pop-entrance` (the pop) + `press-release-spring` (activation flavor) + `counting-dynamic-scale` (the count, if it ticks)
- camera push-in + pan-down centering the tool call / the payoff line → `coordinate-target-zoom` (non-centered target: scale + counter-translate) or `viewport-change`
- slight pull-back then gentle end drift → `multi-phase-camera` (pull-back phase + continuous micro-drift; keep the drift near-imperceptible)
- static hold on the final stack → no rule needed

**camera modifier** (default is a STATIC frame — the theater is element-level; at most ONE real move per shot, chosen from):

- Trigger push-through: a rapid push-in through the opening workspace that clears to the bare canvas → `viewport-change` + `multi-phase-camera`, optional `motion-blur-streak`.
- Receipt zoom: one slow continuous zoom into the checklist card across the whole mutation run, letting the header drift off the top → `multi-phase-camera` (steady push).
- Payoff push-in (sub-shape B's defining move): static through the build, then ONE push-in + pan-down tightening onto the confirmation line, easing to a micro-drift end → `coordinate-target-zoom` / `viewport-change` + `multi-phase-camera` (drift).
- Everything else — swaps, cascades, check-offs, scrolls — happens on a locked frame (any "scroll" is the content translating inside its window, not the camera).

**doctrine note (idle-motion ban)**: the working-state motifs (spinner rotation, pulsing dots, pulsing "Thinking") brush against motion-doctrine's idle-motion ban — here they are DIEGETIC: the pulse _performs_ "the machine is working" and is the narrative content of Scene 2, not decorative breathing. Keep every loop finite, timeline-driven, and seek-safe (`sine-wave-loop` finite repeats, `svg-icon-enrichment` rotation), and kill it at the exact frame the state resolves — the corpus does this explicitly (the loading dots vanish the instant the payload card expands; the spinner swaps out with the loader lockup).

## Selected motion rule: svg-path-draw

---
name: svg-path-draw
description: Animate SVG paths drawing progressively using stroke-dasharray and stroke-dashoffset.
metadata:
  tags: svg, stroke, draw, path, reveal, icon, vector
---

# SVG Path Draw

Reveals an SVG shape by animating its stroke as if a pen were tracing it. Two stroke properties together: **`stroke-dasharray = <pathLength>`** makes the entire path one dash; **`stroke-dashoffset`** starts at the path length (dash shifted fully out of view → invisible) and tweens to `0` (fully drawn). The length comes from the DOM API `path.getTotalLength()` — measured, never guessed.

Works on anything with a stroke: `<path>`, `<circle>`, `<rect>`, `<line>`, `<polyline>`, `<polygon>`, `<ellipse>`.

## Recipe

```html
<!-- inside a standard scene clip -->
<svg class="logo-mark" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <path id="bar-left" d="M 60 40 L 60 160" />
  <path id="bar-right" d="M 140 40 L 140 160" />
  <path id="bar-mid" d="M 60 100 L 140 100" />
</svg>
```

```css
.logo-mark path {
  fill: none; /* outline-only draw — a fill would appear immediately and ruin the reveal */
  stroke: {accentColor};
  stroke-width: 12;
  stroke-linecap: round; /* softer endpoints */
  stroke-linejoin: round;
}
```

```js
// Setup: measure each path and set its dash pattern. Real measured geometry, not a magic number.
document.querySelectorAll(".logo-mark path").forEach((p) => {
  const len = p.getTotalLength();
  p.style.strokeDasharray = `${len}`;
  p.style.strokeDashoffset = `${len}`;
});

// Stagger draws so the eye reads continuous motion — each segment starts at
// ~70-80% of the previous segment's duration, before it finishes.
tl.to(
  "#bar-left",
  { strokeDashoffset: 0, duration: SEGMENT_DRAW_DUR, ease: "power2.out" },
  SEG_1_START,
);
tl.to(
  "#bar-right",
  { strokeDashoffset: 0, duration: SEGMENT_DRAW_DUR, ease: "power2.out" },
  SEG_2_START,
);
tl.to(
  "#bar-mid",
  { strokeDashoffset: 0, duration: FINAL_SEGMENT_DUR, ease: "power2.out" },
  SEG_3_START,
);

// Companion wordmark fades in only after the last stroke settles.
tl.to(
  ".brand-line",
  { opacity: 1, duration: BRAND_FADE_DUR, ease: "power1.out" },
  BRAND_FADE_START,
);
```

## Variations

- **Ring starting at 12 o'clock** — `<circle>` / `<rect>` strokes start at 3 o'clock by default; rotate the element `-90deg` so a progress ring draws from the top:

```html
<circle
  cx="100"
  cy="100"
  r="60"
  id="ring"
  style="transform-origin: 100px 100px; transform: rotate(-90deg)"
/>
```

- **Linear (constant-speed) draw** — `ease: "none"` for a steady-rate "real pen" trace.
- **Draw then fill** — for filled shapes, tween `fillOpacity: 0 → 1` AFTER the stroke completes (requires `fill-opacity: 0` initially and a real `fill` in CSS):

```js
tl.to(
  "#path",
  { strokeDashoffset: 0, duration: SEGMENT_DRAW_DUR, ease: "power2.out" },
  SEG_1_START,
);
tl.to(
  "#path",
  { fillOpacity: 1, duration: FILL_FADE_DUR, ease: "power1.out" },
  SEG_1_START + SEGMENT_DRAW_DUR,
);
```

## Values

| token             | range                                   | notes                                                                                              |
| ----------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| SEGMENT_DRAW_DUR  | 0.3–0.8s                                | fast snap vs deliberate pen trace; >~1s feels sluggish for a logo reveal                           |
| FINAL_SEGMENT_DUR | 60–80% of SEGMENT_DRAW_DUR              | proportional to segment length — a short connector at full duration reads slower than its siblings |
| SEG_N_START       | previous start + 70–80% of its duration | reads as continuous motion, not N isolated animations                                              |
| SEG_1_START       | 0–0.4s                                  | a small ~0.2s lead-in lets the viewer settle before motion                                         |
| BRAND_FADE_START  | ≥ last stroke end (+ ~0.2s beat)        | earlier and the wordmark competes with the draw                                                    |
| BRAND_FADE_DUR    | 0.3–0.8s                                | snap (urgent) vs glide (premium)                                                                   |

Ease families are discrete choices: **stroke draws** use `power2.out` (a hand lifting at end of stroke) or `none` for constant speed — never `back.out` / `elastic.out` (pens don't bounce). **Fades** use `power1.out`.

## Critical Constraints

- **`fill: none`** for outline-only draws — otherwise the fill appears immediately.
- **Dasharray/dashoffset = the measured `getTotalLength()`**, set at setup; requires the SVG in the DOM (inline SVG is fine; a loaded `<image>` SVG is not).
- **Complex paths**: if `getTotalLength()` looks wrong, overestimate slightly (`len * 1.05`) — too large is invisible at animation start; too small clips the end.
- **Stagger multi-path draws at ~70–80%** of the previous segment's duration.
- **A drawn line must land on something.** When the path is a connector (rail, beam, underline, callout) rather than a shape, both endpoints must sit on real elements and the draw must do a job — reveal, route, validate, or emphasize. A stroke that only decorates empty space reads as filler; attach it or cut it.

## See also

`svg-icon-enrichment` (internal parts animate after the outline draws) · `counting-dynamic-scale` (stroke draws an icon while a number counts up) · `hacker-flip-3d` (logo draws, wordmark decodes beneath).
