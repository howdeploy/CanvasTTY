const META = /([()\][%!^"`<>&|;, *?])/g;

/** cmd.exe parses npm's %* twice; preserve the same escaping as provider launches. */
export function windowsBatchShellCommand(executable, args) {
  const argument = (value) => {
    const escaped = value.replace(/(\\*)"/g, (_match, slashes) => `${slashes}${slashes}\\"`).replace(/(\\+)$/, "$1$1");
    return `"${escaped}"`.replace(META, "^$1").replace(META, "^$1");
  };
  return `"${[executable.replace(META, "^$1"), ...args.map(argument)].join(" ")}"`;
}
