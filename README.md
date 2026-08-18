# Bases Plus

Made to fill the gaps in Obsidian's Bases views.

- Keeps the built-in Bases behavior as much as possible and only fills in the missing pieces
- Makes table, timeline, calendar and graph fully workable in Bases
- (This plugin will be discontinued once Obsidian ships similar features natively)

[한국어](README.ko.md) — the Korean page is the primary document; this page follows it

## Install

- Community plugins: search for `Bases Plus` in Obsidian's community plugin browser and install it
- Manual: copy `main.js`, `manifest.json` and `styles.css` from a release into `.obsidian/plugins/bases-plus/` in your vault, then restart Obsidian
- Then open a base and pick one of the `Plus …` view types. The Bases core plugin must be enabled.

## Shared

- Open targets: modal · new tab · new window
  - Pick the default in settings
  - A modal can promote itself to a new tab or window
- Right-click: `Open with Bases Plus`
  - Enable it in settings
  - The same item is available on the built-in Bases views too

## The four views

### Plus table

- Collapsible groups, manual ordering, whole-table paging, per-group paging

![Plus table view showing notes in a table](images/table-en.png)

### Plus timeline

- Timeline with a table pane, timeline properties, colors by status
- Adjustable zoom

![Plus timeline view showing periods as horizontal bars](images/timeline-en.png)

### Plus calendar

- Title options: a checkbox in front, a status picker behind
- Property chips and tasks on the calendar

![Plus calendar view showing notes on a calendar](images/calendar-en.png)

### Plus graph

- X-axis windowing, series from visible properties, legend show/hide

![Plus graph view showing numeric properties as lines](images/graph-en.png)

## Feedback

- Report problems or ideas via [GitHub issues](https://github.com/kim109238/obsidian-bases-plus/issues) or email (kim109238@gmail.com)
- The plugin is maintained in a two-week cycle — feedback is collected first, then fixed in the last two days of the cycle

### Next v1.1

- Crash when editing dates and other properties in the modal
- Clicking a task on the calendar does not open its note
- The + button on a timeline group does not create a file
- Pick list-property values directly in the table, like the built-in table does
- Week separation on the timeline (mark Saturdays and Sundays)
- Y-axis range control for the graph

## Support

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/Q5D224ZJGH)

## Data and network

- Collects nothing and never connects to the internet
- Everything happens inside your vault — and there are no ads

## License

[MIT](LICENSE)
