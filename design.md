# VPS Sentinel Design System

This document is the visual and interaction contract for VPS Sentinel. New UI must extend this language instead of inventing a parallel one.

## 1. Product character

VPS Sentinel is a dense operational instrument, not a generic SaaS dashboard. It should feel calm, precise, compact, dark, and trustworthy. The interface borrows from terminal tooling and the existing tempmail product: near-black surfaces, warm cream emphasis, thin separators, restrained semantic color, compact labels, and very little decoration.

The hierarchy is: current operational state first, supporting metadata second, actions third. Decorative UI never competes with data.

## 2. Color system

Use the existing restrained palette. Neutral surfaces carry almost the entire interface; cream is reserved for selected navigation, primary actions, key values, and keyboard focus.

- Canvas: `#111111`
- Raised canvas: `#161616`
- Primary panel: `#161616`
- Hovered or selected neutral panel: `#1a1a1a`
- Separator: `#222222`
- Strong separator: `#2a2a2a`
- Maximum neutral separator: `#333333`
- Primary text: `#e5e5e5`
- Secondary text: `#999999`
- Muted text: `#666666`
- Primary accent: `#f4ede4`
- Accent hover: `#e8e1d8`
- Success: `#22c55e`
- Warning: `#f59e0b`
- Critical: `#ef4444`
- Informational blue: `#3b82f6`

Semantic colors communicate state only. Never use green or blue as ambient decoration. Never use gradients for text, decorative glows, or glass effects.

## 3. Typography

Use the native sans stack for labels, prose, and controls. Use the project monospace stack for metrics, paths, hashes, timestamps, statuses, and technical metadata.

- Page and pane titles: 14 to 20 px, weight 500 to 600
- Section labels: 10 px, weight 600, uppercase, 0.08 to 0.1 em tracking
- Control labels: 8 to 10 px monospace
- Data rows: 10 to 12.5 px
- Large metric values: 18 to 27 px monospace, light to medium weight
- Body copy: 12 to 13 px, line-height 1.55 to 1.65

Do not create several nearly identical font sizes. A heading must be clearly stronger than body text. Technical values use tabular numerals.

## 4. Spacing and geometry

Use a 4 px spacing base. Preferred values: 4, 8, 12, 16, 20, 24, 32, 48.

- Standard panel radius: 8 to 10 px
- Compact control radius: 5 to 7 px
- Standard panel gap: 12 px
- Dense row height: 38 to 54 px
- Header height across dashboard and drawers: exactly 56 px
- Minimum pointer target: 34 px on dense desktop UI, 44 px on touch layouts

Panels group content only when a clear interaction or comparison boundary exists. Never place decorative cards inside cards. Use alignment, section headings, and one-pixel separators inside a panel.

## 5. Layout rules

### Dashboard

The content canvas owns all available width. The main navigation is an overlay drawer and never permanently steals width from operational data. Right-side detail, notification, Forge, and settings drawers are mutually exclusive.

### Grids

- Six KPI blocks share one row on wide desktop.
- Three-item sections use three columns when space allows.
- When a three-item section becomes two columns, the third item spans the full final row. A half-empty final row is forbidden.
- Primary data surfaces such as Git activity, the file browser, and incident journals span the available width.
- Drawer-aware responsive behavior uses container width, not viewport width alone.

### Drawers

Drawers use the same 56 px header, panel colors, typography, and separators as the dashboard. They enter with `transform` and `opacity` only, using `cubic-bezier(.16,1,.3,1)` over roughly 280 to 320 ms. No bounce.

Settings is a right-side drawer. Its section navigation is a left rail inside the drawer. On narrower layouts that rail slides over the settings content rather than squeezing it.

## 6. Interaction states

Every interactive element needs these states: default, hover, keyboard focus, pressed, disabled, loading, error, and success when applicable.

### Hover

Hover may change background, text color, or a one-pixel border color. Hover must not move the element. Existing legacy translate effects should not be copied.

### Keyboard focus

Use a 2 px cream outline with 2 px offset. Focus must be visible only through `:focus-visible`, never removed without replacement.

### Pressed or active

Pressed state means pointer-down feedback, not persistent selection. It must never change position, size, padding, or geometry. No `translateY`, scaling, or new outer border. Use only:

- a slightly stronger existing background,
- a text or icon color change,
- an inset highlight that does not affect layout.

Persistent selection uses the cream accent, an existing neutral background, or the 2 px navigation marker. Do not confuse pressed and selected states.

### Disabled and loading

Disabled controls remain legible at about 42 percent opacity and use the default cursor or wait cursor where work is active. They do not respond to hover or press. Loading controls keep their dimensions and replace copy only when the replacement cannot shift surrounding layout.

## 7. Navigation

The main navigation drawer opens from the left over the dashboard. A dim scrim closes it on click. Escape closes it. Navigation closes after a destination is chosen. The active section uses cream text and the established 2 px leading marker.

The settings trigger is a button, not a page link. Settings opens in a right-side drawer and keeps the dashboard context visible behind it.

## 8. Forms and settings

Inputs and selects use the panel background, one-pixel strong separator, 6 px radius, monospace technical values, and cream focus outline. Labels are uppercase monospace at 8 px. Forms use one or two columns based on available drawer width.

Secrets are always password inputs, never prefilled, and never returned by APIs. A masked status banner shows whether an integration is configured. Saving uses explicit feedback near the action area. Telegram tests occur only after the user explicitly presses the test action.

## 9. Data visualization

Charts use thin lines, subtle fills, restrained grid lines, and existing semantic colors. Charts redraw in place without animation that obscures live data. Realtime metric drawers update every two seconds and keep hover inspection stable.

Donut charts show no more than eight visible categories. The remainder becomes “Other”. Legends include name, byte total, file count, and percentage. Excluded filesystem areas are disclosed clearly.

## 10. Empty, loading, and error states

Loading states use content-shaped skeletons when possible. Empty states explain what is absent and why. Errors state the failed surface and preserve surrounding navigation. Never replace an entire application surface with a generic spinner.

## 11. Responsive behavior

Responsive work is a re-composition, not shrinking.

- Wide desktop: full data density, multi-column summaries, full-width primary surfaces.
- Compressed split view: two-column summaries, odd final item spans both columns, secondary columns may hide.
- Mobile: one column, 44 px controls, navigation and internal settings rail become overlay drawers, low-priority metadata hides before primary values.

No horizontal page overflow is allowed. Tables and timelines may simplify columns but keep primary identity, status, and action visible.

## 12. Accessibility

Use semantic buttons for actions and links for navigation. Keyboard activation must work for custom rows. Drawers expose `aria-hidden`, controls have readable labels, and status feedback uses live regions where appropriate. Color is never the only carrier of meaning.

## 13. Prohibited patterns

- Position shifts on hover or press
- New borders appearing only while pressed
- Half-empty odd grid rows
- Nested decorative cards
- Gradient text
- Glassmorphism
- Excessive shadows or glows
- Pure black or pure white surfaces
- Arbitrary one-off colors
- Modals when a drawer or inline flow works
- Destructive or privileged actions disguised as ordinary buttons

## 14. Review checklist

Before shipping UI, verify: exact 56 px chrome, no horizontal overflow, no position movement on controls, every control has visible hover/focus/pressed/disabled behavior, odd grid rows fill their container, drawer transitions use transform and opacity, copy is concise, colors come from project tokens, and the result still looks like VPS Sentinel rather than a new template.