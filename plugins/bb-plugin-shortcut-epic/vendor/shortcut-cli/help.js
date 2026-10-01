const GLOBAL_OPTIONS = [
  ["--config PATH", "Select a config file"],
  ["--api-url URL", "Override the Shortcut API URL"],
  ["--workspace SLUG", "Override workspace"],
  ["--epic ID", "Select the Epic, overriding any configured default"],
  ["--team UUID", "Override the configured Team"],
  ["--agent ID", "Override the stable agent identity"],
  ["--human", "Concise human-readable output"],
  ["--pretty", "Indented JSON output"],
  ["-h, --help", "Show help"],
  ["-V, --version", "Show version"],
];

const COMMANDS = {
  init: {
    description: "Discovers the Epic's workflow and writes project configuration.",
    usage: ["init --epic ID [--team UUID] [--workflow ID] [state options]"],
    options: [
      ["--epic ID", "Target Epic"],
      ["--no-default-epic", "Do not save this Epic as the project default"],
      ["--team UUID", "Use this Team instead of the Epic's Team"],
      ["--workflow ID", "Use this Workflow instead of discovering one from the Team"],
      ["--ready-state ID", "Override the discovered Ready state"],
      ["--started-state ID", "Override the discovered Started state"],
      ["--review-state ID", "Override the discovered Review state"],
      ["--done-state ID", "Override the discovered Done state"],
      ["--cancelled-state ID", "Override the discovered Cancelled state"],
      [
        "--completion-mode MODE",
        "Move completed work to review (default) or done",
      ],
      ["--agent ID", "Save a local default agent identity"],
    ],
  },
  config: {
    description: "Prints the effective configuration and its resolved sources.",
    usage: ["config"],
  },
  doctor: {
    description: "Checks Shortcut connectivity, workflow states, and configuration.",
    usage: ["doctor"],
  },
  create: {
    description: "Creates an unowned Story in the Ready state; use start to claim it.",
    usage: [
      "create --title TITLE --description TEXT [options]",
      "create --title TITLE --description-file PATH [options]",
    ],
    options: [
      ["--title TITLE", "Story title (may instead be the first positional argument)"],
      ["--description TEXT", "Story description"],
      ["--description-file PATH", "Read the description from PATH, or - for stdin"],
      ["--type TYPE", "bug, chore, or feature (default: chore)"],
      ["--estimate N", "Set a positive integer estimate"],
      ["--blocked-by ID", "Existing Story blocks this Story (repeatable)"],
      ["--blocks ID", "This Story blocks an existing Story (repeatable)"],
      ["--duplicates ID", "This Story duplicates an existing Story (repeatable)"],
      ["--duplicated-by ID", "An existing Story duplicates this Story (repeatable)"],
      ["--related-to ID", "Add a non-blocking relation (repeatable)"],
    ],
  },
  list: {
    description: "Lists every Story in the selected Epic.",
    usage: ["list [--epic ID]"],
  },
  ready: {
    description: "Lists unblocked Ready-state Stories that have no owners.",
    usage: ["ready [--include-assigned]"],
    options: [
      ["--include-assigned", "Include Ready-state Stories that already have owners"],
    ],
  },
  blocked: {
    description: "Lists blocked Stories and inlines their blocker Stories.",
    usage: ["blocked"],
  },
  show: {
    description: "Shows one Story, its description, and its latest comments.",
    usage: ["show STORY [--all-comments]"],
    options: [
      ["--all-comments", "Return all comments instead of only the latest 10"],
    ],
  },
  edit: {
    description: "Updates fields on an existing Story.",
    usage: ["edit STORY <field options>"],
    options: [
      ["--title TITLE", "Rename the Story"],
      ["--description TEXT", "Replace the description"],
      ["--description-file PATH", "Read the description from PATH, or - for stdin"],
      ["--type TYPE", "Set bug, chore, or feature"],
      ["--estimate N", "Set a positive integer estimate"],
      ["--clear-estimate", "Clear the estimate"],
      ["--move-to-epic ID", "Move the Story to another Epic"],
      ["--set-team [UUID]", "Set the Team, defaulting to the configured Team"],
      ["--clear-team", "Remove the Team"],
      ["--state ID", "Set a raw workflow state ID (bypasses lifecycle guards)"],
    ],
  },
  start: {
    description: "Claims an unowned, unblocked Ready Story and moves it to Started.",
    usage: ["start STORY"],
  },
  complete: {
    description:
      "Records completion evidence and moves an owned Story to Review (or Done when configured).",
    usage: ["complete STORY --summary TEXT [options]"],
    options: [
      ["--summary TEXT", "Required completion summary"],
      ["--verification TEXT", "Verification performed"],
      ["--evidence TEXT", "Evidence or artifact references"],
      ["--changed TEXT", "What changed"],
      ["--remaining TEXT", "Known remaining work"],
      ["--force", "Bypass ownership and Started-state guards"],
    ],
  },
  cancel: {
    description: "Records a cancellation reason and moves a Story to Cancelled.",
    usage: ["cancel STORY --reason TEXT [--force]"],
    options: [
      ["--reason TEXT", "Required cancellation reason"],
      ["--force", "Bypass the ownership guard"],
    ],
  },
  release: {
    description: "Records a reason, clears owners, and returns a Story to Ready.",
    usage: ["release STORY --reason TEXT [--force]"],
    options: [
      ["--reason TEXT", "Required release reason"],
      ["--force", "Release a Story owned by another member"],
    ],
  },
  handoff: {
    description: "Records handoff context, optionally releasing the Story to Ready.",
    usage: ["handoff STORY --summary TEXT [--release] [options]"],
    options: [
      ["--summary TEXT", "Required handoff summary"],
      ["--changed TEXT", "What changed"],
      ["--verification TEXT", "Verification performed"],
      ["--remaining TEXT", "Known remaining work"],
      ["--evidence TEXT", "Evidence or artifact references"],
      ["--release", "Clear owners and return the Story to Ready"],
      ["--force", "Bypass the ownership guard"],
    ],
  },
  dep: {
    description: "Adds or removes one Story dependency, duplicate, or related-Story link.",
    usage: [
      "dep add|remove STORY --blocked-by|--blocks OTHER",
      "dep add|remove STORY --duplicates|--duplicated-by OTHER",
      "dep add|remove STORY --related-to OTHER",
    ],
    options: [
      ["--blocked-by ID", "The other Story blocks STORY"],
      ["--blocks ID", "STORY blocks the other Story"],
      ["--duplicates ID", "STORY duplicates the other Story"],
      ["--duplicated-by ID", "The other Story duplicates STORY"],
      ["--related-to ID", "Add or remove a non-blocking relation"],
      ["--allow-cross-epic", "Allow a relationship between different Epics"],
    ],
  },
  "dep add": {
    description: "Adds one dependency, duplicate, or related-Story link.",
    usage: [
      "dep add STORY --blocked-by|--blocks OTHER",
      "dep add STORY --duplicates|--duplicated-by|--related-to OTHER",
    ],
    options: [
      ["--blocked-by ID", "The other Story blocks STORY"],
      ["--blocks ID", "STORY blocks the other Story"],
      ["--duplicates ID", "STORY duplicates the other Story"],
      ["--duplicated-by ID", "The other Story duplicates STORY"],
      ["--related-to ID", "Add a non-blocking relation"],
      ["--allow-cross-epic", "Allow a relationship between different Epics"],
    ],
  },
  "dep remove": {
    description: "Removes one matching dependency, duplicate, or related-Story link.",
    usage: [
      "dep remove STORY --blocked-by|--blocks OTHER",
      "dep remove STORY --duplicates|--duplicated-by|--related-to OTHER",
    ],
    options: [
      ["--blocked-by ID", "The other Story blocks STORY"],
      ["--blocks ID", "STORY blocks the other Story"],
      ["--duplicates ID", "STORY duplicates the other Story"],
      ["--duplicated-by ID", "The other Story duplicates STORY"],
      ["--related-to ID", "Remove a non-blocking relation"],
      ["--allow-cross-epic", "Allow a relationship between different Epics"],
    ],
  },
  claims: {
    description: "Lists in-flight Story claims and their idle or stale status.",
    usage: ["claims [--mine|--held-by ID] [--stale] [--stale-minutes N]"],
    options: [
      ["--mine", "Only claims held by the configured agent identity"],
      ["--held-by ID", "Only claims held by the specified agent identity"],
      ["--stale", "Only claims at or beyond the stale threshold"],
      ["--stale-minutes N", "Set the stale threshold in minutes (default: 60)"],
    ],
  },
  context: {
    description: "Prints a compact whole-Epic graph summary for agent context.",
    usage: ["context"],
  },
};

const COMMAND_USAGE = [
  "init --epic ID [--team UUID] [--workflow ID] [state options]",
  "config",
  "doctor",
  "create --title TITLE --description TEXT [relations]",
  "list [--epic ID]",
  "ready [--include-assigned]",
  "blocked",
  "show STORY [--all-comments]",
  "edit STORY [field options]",
  "start STORY",
  "complete STORY --summary TEXT [--verification TEXT]",
  "cancel STORY --reason TEXT",
  "release STORY --reason TEXT",
  "handoff STORY --summary TEXT [--release]",
  "dep add|remove STORY RELATION OTHER",
  "claims [--mine|--held-by ID] [--stale] [--stale-minutes N]",
  "context",
];

function formatOptions(options) {
  const width = Math.max(...options.map(([option]) => option.length));
  return options
    .map(([option, description]) => `  ${option.padEnd(width)}  ${description}`)
    .join("\n");
}

export function globalHelp(version) {
  return [
    `shortcut-agent ${version}`,
    "",
    "Agent-first Shortcut work coordination.",
    "",
    "Usage:",
    ...COMMAND_USAGE.map((usage) => `  shortcut-agent ${usage}`),
    "",
    "Global options:",
    formatOptions(GLOBAL_OPTIONS),
    "",
    "Run `shortcut-agent COMMAND --help` for command-specific help.",
    "See README.md for the complete behavioral contract and configuration reference.",
  ].join("\n");
}

export function commandHelp(command, subcommand) {
  const key = command === "dep" && subcommand ? `${command} ${subcommand}` : command;
  const definition = COMMANDS[key];
  if (!definition) return undefined;

  const sections = [
    `shortcut-agent ${key}`,
    "",
    definition.description,
    "",
    "Usage:",
    ...definition.usage.map((usage) => `  shortcut-agent ${usage}`),
  ];
  if (definition.options?.length) {
    sections.push("", "Options:", formatOptions(definition.options));
  }
  sections.push(
    "",
    "Global options:",
    formatOptions(GLOBAL_OPTIONS),
    "",
    "See README.md for the complete behavioral contract and configuration reference.",
  );
  return sections.join("\n");
}
