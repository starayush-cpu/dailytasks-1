# Data Plan

## Context provenance
- `hume ek website or bnani hai jisme kuch project ke names daily calender ho jisme har roj ta tasks kar paaye daily posts, timings and chat on discord if needed website bhut hi professional honi chahiye` (verbatim user request; defines the core: projects, daily calendar, daily tasks with timings, daily posts, Discord chat)
- `glass design` + `awesome fonts and my picture` (verbatim user follow-ups; glassmorphism look, distinctive typography, personal profile identity)
- `kya mai website mai manually bhi add kar pau projects is this possible?` (verbatim user question; manual add/edit/delete of projects inside the website is a hard requirement, answered yes by the parent agent and accepted by the user continuing the build)
- The user-supplied reference image `workspace/user/media_library/image/image-81e04fe9.png` (a glass dashboard mockup: left sidebar with project tags, center Daily Schedule timeline with timed TASK and X POST cards and check-marks, right COMMUNICATION panel with a Discord daily chat target tracker 38/50 and message feed) is the layout/design example to match. It is a design mockup, not the user's photo; its sample names (Sarah, Alex, Alpha-Launch) are mockup content and will NOT be shipped as user data.
- Parent conversation: the user never sent a personal photo and never answered which Discord server or which projects; the parent agent told the user starter projects would be added and the rest can be added manually. Per integrity rules the artifact therefore starts EMPTY (no invented projects, tasks, or Discord messages) with full manual add/edit/delete, and the profile uses the user's real name/handle from standing memory (Ayush / starayush, @_star_ayush) with a monogram avatar instead of a fabricated photo.
- Standing memory facts used only as optional quick links, not as seeded records: the user's Discord communities are Fermah and Dlicom; the Discord panel links out to discord.com/app (generic) and lets the user save their own server/channel links per project/day rather than hard-coding memberships.

## Tested sources
No external data API is used. All content is user-entered and stored in the artifact's own database (ctx.db), which also answers the user's sync concern better than the browser-only storage the parent agent first described: projects and tasks persist server-side per artifact.

### Google Fonts (design only)
**Used by**: client theme.css @import
**Test command**: fonts are loaded via the standard Google Fonts CSS import already supported by the scaffold theme.css slot; families: Sora (display) + Manrope (body)
**Processing**: typography only, no content data.

## Long-term data behavior
- **Refresh policy**: One scheduled refresh from the handoff: daily cron invoking the `rolloverDay` action, which creates fresh unchecked instances of recurring daily tasks for the new date, carries the Discord daily chat target forward, and leaves past days untouched as history. The client also calls rollover lazily on load so opening the app on a new day is correct even before the cron fires.
- **Growth**: One task-instance row per task per day; projects and task templates are small user-managed lists. History is kept per date so the calendar can show past completion.
- **Ordering**: Today's schedule sorts by time ascending, untimed items last; projects sort by creation order; calendar is a month grid.
- **Time semantics**: Dates are plain local calendar dates (YYYY-MM-DD strings) in the user's timezone (Asia/Kolkata per timestamps); task times are local wall-clock HH:MM strings, rendered as 12-hour labels. No cross-timezone conversion is applied to a personal daily planner.

## Imagery
Imagery not needed: the only personal visual is the user's profile, rendered as a glass monogram avatar (A / starayush) because no real photo was supplied; inventing or generating a photo of the user would be false. The reference mockup is matched through CSS glass panels and gradients, not image assets.

## Rejected approaches
- **Tried**: Seed starter projects/tasks/Discord messages from the mockup and memory (Dili Streak Brawl, Fermah Quiz Hub, 50-message target, sample chat)
  **Why rejected**: The user never confirmed the project list, Discord server, or chat target; seeding them would present invented records as the user's own. The app starts empty with strong empty states and one-tap add forms instead; the mockup's 50-message target survives only as an editable placeholder suggestion in the target field.
- **Tried**: Browser localStorage persistence (as the parent agent first described to the user)
  **Why rejected**: The fullstack runtime provides a real per-artifact database; server storage keeps projects and history in one place and powers the daily rollover action and the widget.
