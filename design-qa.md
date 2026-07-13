# Design QA — Option 3 “Kinetic Desk Toy”

- Source visual: `/Users/denny/Work/biebeiaitidai/docs/UI-option-3-kinetic-desk-toy.png`
- User-device evidence: `/Users/denny/Work/biebeiaitidai/build/qa/user-device-before.png`
- Final entry: `/Users/denny/Work/biebeiaitidai/build/qa/01-start-final-390x844.png`
- Final gameplay: `/Users/denny/Work/biebeiaitidai/build/qa/02-playing-final-390x844.png`
- Final result: `/Users/denny/Work/biebeiaitidai/build/qa/03-result-final-390x844.png`
- Comparison: `/Users/denny/Work/biebeiaitidai/build/qa/ui-final-comparison.png`
- Queue card fix screenshot: `/Users/denny/Work/biebeiaitidai/build/qa/card-fix/09-cardfix2-settled.png`
- Queue card focused comparison: `/Users/denny/Work/biebeiaitidai/build/qa/card-fix/10-queue-comparison.png`
- Viewport: 390 × 844 CSS px, portrait

## Final findings

- No actionable P0/P1/P2 issue remains at the tested viewport.
- Layout: title, timer, monitor, conveyor, desk character, approval gauge, event strip, and action dock retain the selected visual order. All content stays inside safe bounds without clipping or unintended overlap.
- Typography: all runtime labels use the centralized PingFang SC hierarchy. Long labels shrink inside measured bounds; threshold, action, and status text remain readable.
- Components: task cards, prop keycaps, approval gauge, panels, and result actions share one light direction, border scale, radius scale, shadow depth, and six-state control grammar.
- Color: warm ivory/charcoal/walnut environment colors are separated from functional colors. Danger red is reserved for danger/rework; locked controls use neutral warm gray; the yellow zone and result rating meet stronger contrast than the prior build.
- Assets: robot, monitor, task/prop icons, and transparent desk decoration are real project assets. No placeholder emoji, text symbol icon, or temporary code-drawn lock remains visible.
- Interaction: entry CTA, press feedback, charge/drag/release, target feedback, cooldown/locked/depleted states, result transition, retry, revive, next/back, and safe-area placement remain connected to gameplay state.
- Runtime: final browser pass produced no console warnings or errors. TypeScript passed, 92 tests passed, and both Web Mobile and WeChat Game Cocos builds completed.

## Queue card focused pass — 2026-07-12

- Source visual truth: `/Users/denny/Work/biebeiaitidai/docs/UI-option-3-kinetic-desk-toy.png`
- Implementation screenshot: `/Users/denny/Work/biebeiaitidai/build/qa/card-fix/09-cardfix2-settled.png`
- Full/focused comparison evidence: `/Users/denny/Work/biebeiaitidai/build/qa/card-fix/10-queue-comparison.png`
- Viewport and state: 390 × 844 CSS px, playing state, conveyor cards moving through the queue.
- Primary interactions tested: entry CTA into gameplay; waited for conveyor card spawn/movement state.
- Console errors checked: no blocking runtime error observed during browser capture.
- Fonts and typography: task card labels now use the shared PingFang SC hierarchy, white bold text, shrink bounds, and no overflow on the tested viewport.
- Spacing and layout rhythm: card ratio was corrected from a skinny placeholder feel to a taller cartridge form, with side inset so static slots do not jam into the conveyor rounded corners. Moving entry/exit cards may be partially clipped by the belt mask by design.
- Colors and visual tokens: active cards now use saturated blue/orange/purple/cyan/amber/charcoal faces with dark physical bases; empty slots are dark subdued segments instead of pale competing boxes.
- Image quality and asset fidelity: task icons were converted from dark gray to warm white project PNG assets, matching the reference direction of white glyphs on colored cards.
- Copy/content: card labels use the configured card definitions (`常规`, `汇报`, `关键`, etc.); this is gameplay content and intentionally differs from the mock's illustrative labels.
- Remaining P3: the reference queue image shows a full six-card, non-random demonstration state, while the implementation evidence is a live dynamic conveyor state with partial entry/exit cards and an effect badge. This is expected and not a P0/P1/P2 mismatch.

## Resolved from user-device evidence

- Desk objects moved out of the monitor and onto the desk plane.
- Tutorial feedback moved into the event strip and no longer blocks the approval gauge.
- Task cards were enlarged and the conveyor track was re-proportioned to match the source visual weight.
- The robot was enlarged and centered as the primary scene subject.
- The approval gauge was rebuilt as a dedicated component with readable ticks, a physical cursor, four clean zones, and a separate event capsule.
- Prop controls gained consistent keycap depth, optical icon sizing, text hierarchy, press feedback, and locked/depleted/cooldown/ready/charging states.
- Entry and result pages were re-composed using the same panel and keycap material system.

final result: passed

## Prop drag operation zone — 2026-07-13

- Local preview: `http://127.0.0.1:4192/?v=prop-drag-zone-final5`
- Hold-state screenshot: `/Users/denny/Work/biebeiaitidai/qa-prop-drag-zone-final5-390.png`
- Viewport: 390 × 844 CSS px, portrait, live Cocos web-mobile runtime.

### What changed

- Bottom prop buttons are no longer backed by a persistent dock during normal play; the dock appears only after a prop is pressed.
- Pressing a usable prop hides the other prop buttons and turns the selected prop into a draggable token inside a large operation zone.
- The operation zone uses the same warm paper/keycap material system as the rest of the UI, with a dark header strip, guide rail, and prop index dots.
- Drag movement is clamped to the operation zone bounds on both X and Y, so the prop cannot visually escape the interaction area.
- Releasing the prop hides the operation zone, restores the prop buttons, and sends the prop into the existing throw/use animation.

### Verification

- `npm test`: 92 tests passed.
- Cocos `web-mobile` build completed; Creator still exits with code 36/SIGTERM after the successful build task, but the build log ends with `build Task (web-mobile) Finished`.
- Browser runtime state check confirmed: hold state has `dockActive=true`, all bottom buttons hidden, drag token inside dock bounds; release state has `dockActive=false`, all buttons restored, and the prop leaves via animation.
- Cocos editor layout/window JSON warnings came from `/Users/denny/.CocosCreator/editor/*.json` and did not block web-mobile build output.

final result: passed

## Layout repair review — 2026-07-13

- Local preview: `http://127.0.0.1:4191/?v=layout-repair-2`
- Entry screenshot: `/Users/denny/Work/biebeiaitidai/build/qa/final-repair/qa-layout-repair-2-entry-390.png`
- Gameplay screenshot: `/Users/denny/Work/biebeiaitidai/build/qa/final-repair/qa-layout-repair-2-game-390.png`
- Result screenshot: `/Users/denny/Work/biebeiaitidai/build/qa/final-repair/qa-layout-repair-2-result-390.png`
- Viewport: 390 × 844 CSS px, portrait, live Cocos web-mobile runtime.

### Findings fixed

- Entry page lower brown block was removed; it looked like an accidental background seam rather than intentional staging.
- Entry CTA was changed from a flat webpage-like button to the shared keycap material used by the rest of the UI.
- Entry card was moved lower and its text grouping was rebalanced so the title, instruction line, steps, CTA, and progress copy read as one centered panel.
- Gameplay title was restored as the primary title instead of collapsing into a weak header; the level line remains below it.
- Timer pill was widened, centered, and redrawn with a stronger physical capsule so the number no longer feels clipped or misaligned.
- Desk decoration was widened and shifted outward so plant/pen/cup/notepad no longer crowd the robot as aggressively.
- Result buttons were unified into the same keycap material and sizing; color now communicates action priority instead of looking like three unrelated button systems.

### Verification

- `npm test`: 92 tests passed.
- Cocos `web-mobile` build completed; Creator still exits with code 36/SIGTERM after the successful build task, but the build log ends with `build Task (web-mobile) Finished`.
- Browser QA covered entry, gameplay, and natural timeout result at 390 × 844.

final result: passed

## Final layout polish pass — 2026-07-13

- Local preview: `http://127.0.0.1:4191/?v=final-anchor-polish-2`
- Entry screenshot: `/Users/denny/Work/biebeiaitidai/build/qa/final-polish/qa-final-anchor-entry-390.png`
- Main gameplay screenshot: `/Users/denny/Work/biebeiaitidai/build/qa/final-polish/qa-final-anchor-2-game-390.png`
- Result screenshot: `/Users/denny/Work/biebeiaitidai/build/qa/final-polish/qa-final-anchor-result-390.png`
- Viewport: 390 × 844 CSS px, portrait, live Cocos web-mobile runtime.

### What changed

- Entry page was rebuilt around the same “monitor shell + paper inner screen + dark capsule header” language as gameplay, replacing the earlier webpage-like white card.
- Main title and timer were rebalanced: smaller centered title, fixed timer pill, reduced text pressure, and safer right-side alignment.
- Main scene vertical anchor was corrected so the monitor/desk/character sit higher and the title area no longer feels disconnected.
- Conveyor remained lower inside the monitor, leaving better separation from the “处理/入口” labels while keeping cards readable.
- Approval panel was moved upward and rebuilt around an empty physical track: the static layer is neutral gray, dynamic fill now reflects the current status color, and the initial visual no longer looks pre-filled.
- Event row was enriched with a left tag, amber dot, divider, and cleaner event copy instead of a plain thin text strip.
- Result modal now uses a compact status capsule, rating badge, metric chips, and a separate note card, replacing the previous harsh square/grid feeling.

### Verification

- `npm test`: 92 tests passed.
- Cocos `web-mobile` build completed; Creator still exits with code 36/SIGTERM after the successful build task, but the build log ends with `build Task (web-mobile) Finished`.
- Browser QA covered entry, gameplay, and natural timeout result at 390 × 844. The Cocos editor window recovery warning is from `/Users/denny/.CocosCreator/editor/window.json` and did not block build output.

final result: passed

## Second polish pass — cards and button hierarchy — 2026-07-12

- Final live-flow screenshot: `/Users/denny/Work/biebeiaitidai/build/qa/refine/final-refined-cards-buttons-v4-flow-390.png`
- Immediate gameplay screenshot: `/Users/denny/Work/biebeiaitidai/build/qa/refine/final-refined-cards-buttons-v3-390.png`
- Button contact sheet after recolor: `/Users/denny/Work/biebeiaitidai/build/qa/refine/refined-buttons-contact-v3.png`
- Viewport: 390 × 844 CSS px, portrait, Canvas runtime.

### What changed

- Task card labels are now hidden in the moving queue. On mobile they competed with the card icon/accent and made the card feel like a small UI tag instead of a physical task object.
- Task card icons were enlarged from roughly half-card scale to the card’s main visual area, compensating for transparent margins inside source PNGs.
- `btn_change_requirement_wide` was recolored from the cropped demo-blue button into a purple button while preserving the original edge highlights, inner gloss, icon, text, and shadows. “加需求” and “改需求” now have clear hierarchy and no longer read as duplicate blue actions.

### Verification

- `npm test`: 92 tests passed.
- Cocos `web-mobile` build completed; Creator still exits with code 36/SIGTERM after the successful build task, but the build log ends with `build Task (web-mobile) Finished`.
- Browser QA at 390 × 844 confirms live queue cards, locked buttons, and active buttons render with no Cocos renderable-component warnings. The only observed console error is the harmless local `favicon.ico` 404.

final result: passed

## Asset-first UI refactor pass — 2026-07-12

- Reference implementation inspected: `/Users/denny/Work/feiga/cocos/ai-office/assets/scripts/GameRoot.ts`
- Imported asset family: `/Users/denny/Work/biebeiaitidai/assets/resources/art/ui-v4/`
- Final mobile screenshot: `/Users/denny/Work/biebeiaitidai/build/qa/asset-refactor/final-390-cards.png`
- Reference/current queue comparison: `/Users/denny/Work/biebeiaitidai/build/qa/asset-refactor/task-card-comparison.png`
- Viewport: 390 × 844 CSS px, portrait, live gameplay state.

### What changed

- Task cards now use `task_card_base` + `task_card_accent_*` SpriteFrames + category icon + label. The previous “full colored button card” treatment is no longer the primary rendering path.
- Prop buttons now prefer complete button PNG assets (`btn_add_requirement`, `btn_change_requirement`, `btn_blame`) and only fall back to generated keycaps when an asset is unavailable.
- Card layout was rebalanced after browser QA: slot side insets and gaps were reduced, card height was raised, and icon scale was increased so mobile cards read as physical objects rather than small tags.
- Graphics are now kept as fallback/dynamic layers for empty slots, progress, state, and effects instead of carrying the main material look.

### Verification

- `npm test`: 92 tests passed.
- Cocos `web-mobile` build completed; Creator still exits with code 36/SIGTERM after the successful build task, but the build log ends with `build Task (web-mobile) Finished`.
- Browser QA covered start screen, gameplay HUD, queue card spawn state, approval/event panel, and prop button row at 390 × 844.

### Remaining design note

- The live queue is intentionally random and moving, so screenshots may show fewer than six cards or partial entry/exit cards. The underlying visual grammar now follows the demo direction: dark physical card base, category accent layer, large icon, and label.

## Button asset polish pass — 2026-07-12

- Final screenshot: `/Users/denny/Work/biebeiaitidai/build/qa/refine/final-refined-cards-buttons-390.png`
- Button asset contact sheet: `/Users/denny/Work/biebeiaitidai/build/qa/refine/wide-buttons-contact.png`
- Viewport: 390 × 844 CSS px, portrait, live gameplay state.

### What changed

- Added runtime-ready wide button assets under `/Users/denny/Work/biebeiaitidai/assets/resources/art/ui-v4/`:
  - `btn_add_requirement_wide`
  - `btn_change_requirement_wide`
  - `btn_throw_pot_wide`
  - `btn_kiss_up_wide`
  - matching `*_locked_wide` assets
- The first two wide assets are cropped from the demo’s complete PNG buttons, preserving their original icon/text/lighting detail without the oversized transparent 313 × 313 padding.
- The third and fourth buttons now have complete PNG treatments for `甩锅` and `拍马屁`, including matching locked-state assets. They no longer fall back to flat gray generated keycaps.
- `PropButtonView` now renders PNG assets through a dedicated child Sprite node (`PropBgAsset`) while keeping the parent Graphics node only as fallback. This avoids Cocos’ “one renderable component per node” conflict.

### Verification

- `npm test`: 92 tests passed.
- Cocos `web-mobile` build completed; Creator still exits with code 36/SIGTERM after the successful build task, but the build log ends with `build Task (web-mobile) Finished`.
- Browser QA confirms the bottom prop buttons render as full PNG assets at 390 × 844, and task cards + buttons coexist cleanly in the live gameplay state.

final result: passed
## Minimal start page card/button refinement — 2026-07-14

- Reference screenshot supplied by user: `/var/folders/jn/1zg6fv2x4p5d_ynwx4p2g4pm0000gn/T/codex-clipboard-de825c84-aeff-4157-9987-af18da7fc4ad.png`
- Final browser QA screenshot: `/Users/denny/Work/biebeiaitidai/qa-start-card-button-v8.png`
- Runtime: Cocos web-mobile build, local browser preview.

### What changed

- Tightened start-card metrics so the entry card no longer feels like a stretched horizontal panel in wider previews, while keeping the tall-phone layout close to the supplied reference.
- Rebalanced card vertical position, radius, border, and shadow to read softer and closer to the paper mock.
- Reduced the primary CTA’s height, text size, play icon size, highlight strip, and bottom depth so it reads like the reference’s friendly thick button instead of a heavy blue brick.
- Reworked the spacing between the three gameplay cards, CTA, and progress row to remove overlap and restore clear rhythm.
- Adjusted the three gameplay cards toward rounded soft chips with lighter icon badges.

### Verification

- `npx tsc --noEmit`: passed.
- `npm test`: 92 tests passed.
- Cocos `web-mobile` build completed; Creator still exits with code 36/SIGTERM after the successful build task, but the build log ends with `build Task (web-mobile) Finished`.
- Browser console check: no warning/error messages on the refined start page.

final result: passed

## Minimal start page rebuild — 2026-07-13

- Reference screenshot supplied by user: `/var/folders/jn/1zg6fv2x4p5d_ynwx4p2g4pm0000gn/T/codex-clipboard-de825c84-aeff-4157-9987-af18da7fc4ad.png`
- Final browser QA screenshot: `/Users/denny/Work/biebeiaitidai/qa-start-minimal-v5-390.png`
- Runtime: Cocos web-mobile build, local browser preview.

### What changed

- Rebuilt the start page around warm paper beige, off-white card, soft beige chips, and one friendly blue accent.
- Removed the heavy dark monitor/card frame from the entry screen.
- Added a light status pill with breathing blue dot: `AI显示器 · 生存实验`.
- Replaced inline tiny step text with three equal step cards using icon badges for hold / target / throw.
- Replaced the old generic keycap CTA with a thick game button: blue face, darker bottom depth, highlight strip, press displacement, and play icon.
- Kept Cocos text on `PingFang SC`; the requested web-style Baloo/CJK font stack rendered incorrectly inside Cocos `Label`, so a real Baloo treatment should be imported later as a font asset instead of using a CSS font-family list.

### Verification

- `npx tsc --noEmit`: passed.
- `npm test`: 92 tests passed.
- Cocos `web-mobile` build completed; Creator still exits with code 36/SIGTERM after the successful build task, but the build log ends with `build Task (web-mobile) Finished`.
- Browser console check: no warning/error messages on the rebuilt start page.

final result: passed
