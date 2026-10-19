---
name: Relay
description: A local dispatch workspace for traffic and publishing.
colors:
  ink: "#173139"
  muted: "#64777e"
  teal: "#087b6b"
  line: "#e0e7e8"
  surface: "#fff"
  canvas: "#f4f6f7"
  body-text: "#243b43"
  navigation: "#142f37"
  primary-button: "#0a7c6b"
  primary-button-hover: "#066656"
  focus: "#22b7a3"
  positive-surface: "#e9f6ef"
  positive-text: "#277253"
  pending-surface: "#f5f1e7"
  pending-text: "#7b662b"
  rejected-surface: "#fceceb"
  rejected-text: "#aa3935"
typography:
  headline:
    fontFamily: "DM Sans Variable, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "29px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.035em"
  title:
    fontSize: "15px"
    fontWeight: 650
    letterSpacing: "-0.015em"
  body:
    fontFamily: "DM Sans Variable, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
  label:
    fontSize: "12px"
    fontWeight: 550
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "12px"
rounded:
  badge: "4px"
  icon-control: "6px"
  control: "7px"
  notice: "8px"
  panel: "12px"
spacing:
  control-gap: "8px"
  action-gap: "10px"
  grid-gap: "23px"
components:
  button-primary:
    backgroundColor: "{colors.primary-button}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "9px 14px"
  button-primary-hover:
    backgroundColor: "{colors.primary-button-hover}"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
  badge-positive:
    backgroundColor: "{colors.positive-surface}"
    textColor: "{colors.positive-text}"
    rounded: "{rounded.badge}"
    padding: "3px 7px"
---

# Design System: Relay

## Overview

**Creative North Star: "The Dispatch Workspace"**

Cool, orderly operational screens pair a dark navigation rail with light working surfaces. Flat metrics and aligned rows make activity, routing, attribution and publication states easy to inspect. Teal carries primary actions; restrained status colors distinguish outcomes without dominating the workspace.

**Key Characteristics:**

- Compact, readable data hierarchy and tabular numbers.
- White bordered panels on a pale slate canvas.
- One locally bundled variable sans family; original interface without vendor assets.

This is a descriptive extraction from `src/style.css` and `src/main.tsx`, with product constraints from `PRODUCT.md` and direction context from `.impeccable/direction.md`. Source and final cascade take precedence over the earlier direction. Review captures were reported at desktop (1265 × 712) and narrow (615 × 548); this extraction did not inspect images or run a browser. Behavior at 390px remains unverified.

## Colors

The palette uses deep blue-green navigation, cool neutrals and a small operational teal accent.

### Primary

- **Teal:** the `teal` primitive supplies caret and field focus color. Primary buttons use the separate `primary-button` value, with `primary-button-hover` on hover.
- **Focus mint:** the `focus` primitive marks keyboard focus on links and buttons.

### Secondary

- **Outcome colors:** positive surfaces/text mark active, approved, published and converted states. Pending colors mark paused and draft states; rejected colors mark rejected outcomes. Labels accompany color.
- AI generation controls have a localized lavender treatment; it is not the default action color.

### Neutral

- **Ink / body text:** ink is a root primitive; actual body text uses `body-text`. Headings have their own closely related dark tones in source.
- **Muted:** explanatory copy and secondary labels.
- **Surface / canvas / line:** white working panels, pale page background and quiet separators.
- **Navigation:** dark fixed rail with lighter labels and a tonal selected item.

**The Role Fidelity Rule.** Preserve the distinct button, body and token colors rather than replacing all near-teal or near-ink values with one guessed color.

## Typography

DM Sans Variable is imported locally through `@fontsource-variable/dm-sans`, with system sans fallbacks. The hierarchy is compact rather than promotional: main headings use the headline role; panel titles use title; fields and buttons use label. Page headings reduce to (25px) below the 850px breakpoint, then become (26px) below 680px.

Metric values use tabular numbers, tight tracking and medium weight (600). The final desktop override makes them (27px); narrow screens use (28px). Tables use (12px) content and (10px) column headers. Code, identifiers and URLs use the code stack; some code rows reduce to (11px). Secondary operational copy frequently uses (10–12px).

## Layout

The fixed navigation rail is (222px), reducing to (194px) at 1150px and (180px) at 850px. Content offsets match the rail. Main content has a maximum width (1510px), with horizontal padding stepping from (38px) to (25px), (21px), then (17px).

The final stylesheet override applies above 680px: header height (56px), main top padding (24px), heading bottom gap (20px), metric vertical padding (12px), metric bottom gap (16px), chart SVG height (90px), chart bottom padding (13px), chart panel bottom gap (18px). These override earlier large-screen values, including the 1550px chart height. This density puts the first campaign row into the reported desktop first viewport.

Metrics use four columns, then two below 680px. Lower overview panels reduce from two columns to one below 850px. Article editing moves from content plus sidebar to one main column at 850px; its options become a single column below 680px. Form grids similarly collapse below 680px. Data tables preserve columns and scroll horizontally rather than becoming decorative cards.

Below 680px, navigation becomes a hidden (228px) off-canvas rail, revealed by a menu button and backed by a scrim. Header height is (58px). The chart uses (150px) height on narrow screens. CSS behavior is source-derived; smallest-device fit has not been verified.

## Elevation & Depth

Ordinary panels are flat: borders, background changes and spacing supply hierarchy. Shadows are reserved for temporary layers: simulator drawer (`-6px 0 35px #132d3518`) and toast (`0 6px 22px #102a2920`). Translucent scrims separate drawer and mobile navigation from the workspace.

## Shapes

Panels use the panel radius; controls use the smaller control radius, badges the badge radius. Icon buttons use the icon-control radius. Notices and article icons use the notice radius. Circular avatars and status dots distinguish identity and state. Thin borders, compact rounded rectangles and aligned table rows define the form language.

## Components

Crawler settings inherit the existing form-section vocabulary: a native enable checkbox, a labeled URL input and a fieldset of Google/Meta checkboxes. The simulator adds a request-profile select. Traffic log switches between visitor clicks and claimed crawler requests using the existing tab controls. Always retain the user-agent-only/unverified wording; semantic badges describe claimed groups without implying authenticated origin.

- **Buttons:** compact inline icon/label controls, minimum height (38px), with smaller row actions (31px). Primary hover darkens; neutral hover lightly tints. Disabled buttons use opacity (.48) and a blocked cursor. Active buttons shift down (1px). Buttons and links receive a (3px) focus outline with (3px) offset.
- **Fields:** white inputs with a fine border, control radius and padding (10px 12px); field controls have minimum height (40px). Focus uses a (2px) teal outline with (1px) offset. Textareas resize vertically. Visible field labels and contextual help accompany forms; errors appear in separate red-tinted notices.
- **Navigation:** icon and label rows, tonal selected state and `aria-current="page"`. Closed mobile navigation uses both transform and visibility, removing hidden controls from keyboard access. Opening focuses the selected item, traps Tab, makes the workspace inert and locks scrolling; Escape closes and restores previous focus.
- **Data panels:** bordered containers with compact headings, scrollable tables, numeric right alignment and subtle row hover. Status badges retain readable text alongside their colored dot.
- **Traffic chart:** restrained teal line and pale area over dashed gridlines. Hover exposes a daily summary. The **Daily data** button reveals the same dates, clicks and conversions in a labeled table and exposes its expanded state; chart inspection does not rely solely on pointer interaction.
- **Routing simulator:** right-side dialog (480px maximum viewport width), numbered result steps and separate simulation/real-visit actions. Escape, focus trapping, restored focus and inert background support the dialog lifecycle.
- **Publishing:** filter buttons with counts, compact article rows and a separate lavender AI draft action. Generation is a form; articles retain draft/published labels and deliberate save/publish actions.
- **Feedback and motion:** notices remain inline; a fixed toast enters over (.18s ease-out). Button state transitions use (.16s); field border transitions (.15s); mobile rail movement (.2s). Reduced-motion preferences disable animation and transitions.

## Do's and Don'ts

- **Do** preserve compact headings, aligned numeric columns and readable state labels.
- **Do** keep full daily chart values reachable through the table alternative.
- **Do** preserve visible focus and hidden-navigation keyboard behavior when adding controls.
- **Do** check the final cascade when changing desktop density or responsive sizing.
- **Don't** add resting shadows to ordinary data panels; use borders and tonal separation.
- **Don't** replace operational tables with promotional tiles or invent metrics and customer claims.
- **Don't** treat the unverified 390px viewport as established responsive evidence.
