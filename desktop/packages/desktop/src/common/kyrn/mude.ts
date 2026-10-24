/**
 * mude, mu's own judge model, on a Mac with Apple silicon. The app never downloads or starts anything for it itself:
 * the main process runs mu's command `mu judge mude <cmd> --json` (process/agent/kyrn/mude.ts), one at a time, and
 * keeps what it reports for the settings page to show.
 *
 * - install: downloads the model, sets up its Python environment, starts its server and makes it mu's judge.
 * - enable / disable: puts mude first in mu.json's `tiers`, or restores the judges it replaced (and stops the server).
 * - start / stop: its server on 127.0.0.1, shared by every mu session on this Mac.
 * - uninstall: disables it and deletes everything it installed.
 *
 * The app adds two actions of its own: `cancel` ends a running install (the command resumes the download next time),
 * and `open` shows mude's folder in the file manager.
 */

/** What the command does. */
export type MudeCommand = 'install' | 'enable' | 'disable' | 'start' | 'stop' | 'uninstall';
export type MudeAction = MudeCommand | 'cancel' | 'open';

export const MUDE_COMMANDS: readonly MudeCommand[] = ['install', 'enable', 'disable', 'start', 'stop', 'uninstall'];

/** The commands that change mu.json: the settings are read again after each. */
export const MUDE_CHANGES_SETTINGS: ReadonlySet<MudeCommand> = new Set(['install', 'enable', 'disable', 'uninstall']);

/** What `mu judge mude status --json` reports. */
export type MudeStatus = {
  /** False on a Mac without Apple silicon, before macOS 14, or with less than 8 GB of memory; `problems` say why. */
  supported: boolean;
  /** Why it is not supported, in English. */
  problems: string[];
  /** The model is downloaded. */
  installed: boolean;
  /**
   * Bytes of the model on disk, partly downloaded files included: while not installed, an install that stopped part
   * way (the next one goes on from there). Unset when there are none, or from a mu that does not say.
   */
  downloadedBytes?: number;
  /** Its Python environment is set up. */
  pythonReady: boolean;
  /** Its server runs. */
  running: boolean;
  /** Its server answers. */
  ready: boolean;
  port: number;
  pid?: number;
  /** What the server uses, while it runs. */
  memoryBytes?: number;
  /** mude is first in mu.json's `tiers`. */
  enabled: boolean;
  /** mude is the only judge: no decision goes to a judge behind it. */
  localOnly: boolean;
  /** The judges behind mude, by their names in mu.json (e.g. `jev`). */
  fallback: string[];
  model: string;
  folder: string;
  /** The server's log file. */
  log: string;
};

/** The stages of a command, each with a sentence of its own. */
export type MudeStep = 'download' | 'python' | 'start' | 'enable' | 'disable' | 'stop' | 'uninstall';

/**
 * Why a command failed. access: Hugging Face refused the download. network: it could not be reached. integrity: a
 * downloaded file does not match. aborted: it was stopped. usage: the command was called wrongly (exit code 2).
 * unsupported: this Mac cannot run mude.
 */
export type MudeErrorKind = 'access' | 'network' | 'integrity' | 'aborted' | 'usage' | 'unsupported';

export type MudeDownload = {
  file: string;
  /** Bytes of the whole model. */
  done: number;
  total: number;
  /** The file is being verified. */
  checking: boolean;
};

export type MudeTask = {
  id: number;
  command: MudeCommand;
  phase: 'running' | 'done' | 'failed' | 'cancelled';
  step?: MudeStep;
  /** The command's sentence for its current step, in English: the app says each step in its own words instead. */
  message?: string;
  /** While the model downloads. */
  download?: MudeDownload;
  /** The last lines of the Python packages' installation. */
  log: string[];
  error?: { message: string; kind?: MudeErrorKind };
};

export type MudeState = {
  /** Whether this app offers mude at all: on macOS. Elsewhere nothing is run and the page shows nothing of it. */
  available: boolean;
  /** What mude's status was last; unset until the command first answered. */
  status?: MudeStatus;
  /** Why the status could not be read (a mu without the command, a command that failed), in English. */
  problem?: string;
  /** What runs now, or ran last; unset before the first command of this app run. */
  task?: MudeTask;
};

/**
 * What installing takes, about, for the consent: the model, its Python environment, and memory while it runs. Download
 * sizes are in decimal gigabytes (10⁹ bytes), as Hugging Face gives them: the model is 1,782,006,237 bytes.
 */
export const MUDE_DOWNLOAD_GB = 1.8;
/** Bytes in a gigabyte of a download, as MUDE_DOWNLOAD_GB counts them. */
export const DOWNLOAD_GB_BYTES = 1e9;
export const MUDE_PYTHON_GB = 1;
export const MUDE_MEMORY_GB = 4;
/** The memory a Mac needs to run mude at all (the command's own check). */
export const MUDE_MIN_RAM_GB = 8;

// ---------------------------------------------------------------------------------------------------------------

/**
 * Decision models from Hugging Face beside mude, on a Mac with Apple silicon. As for mude, the app runs mu's command,
 * `mu judge model <cmd> --json` (DecisionModels in process/agent/kyrn/mude.ts), one at a time:
 *
 * - add: looks a model up on Hugging Face by its link or owner/name, downloads it (resuming one that stopped), sets it
 *   up, starts its server and makes it mu's judge.
 * - use: makes an added model, or mude, the judge again; the other one's server stops.
 * - disable: takes it out of the judge order (the judges it replaced come back) and stops its server.
 * - remove: takes it out of the judge order and deletes it.
 *
 * `cancel` ends a running add: the command resumes the download next time.
 */

export type ModelCommand = 'add' | 'use' | 'disable' | 'remove';
export type ModelAction = ModelCommand | 'cancel';

export const MODEL_COMMANDS: readonly ModelCommand[] = ['add', 'use', 'disable', 'remove'];

/**
 * Why adding a model failed, beside mude's kinds: notFound (no such model or revision on Hugging Face), notRunnable
 * (not packaged so mu can run it: no d3_server_mac.py). access: private or gated.
 */
export type ModelErrorKind = MudeErrorKind | 'notFound' | 'notRunnable';

/** One line of `mu judge model list --json`: mude first, then every model added here. */
export type DecisionModel = {
  /** Its name in the judge order and in the command: `mude`, or the id given when it was added. */
  name: string;
  label: string;
  /** owner/name on Hugging Face. */
  repo: string;
  /** The commit it is pinned at. */
  revision: string;
  bytes: number;
  /** mude itself. */
  builtIn: boolean;
  /** Downloaded and set up. */
  installed: boolean;
  downloadedBytes: number;
  running: boolean;
  ready: boolean;
  /** First in the judge order. */
  enabled: boolean;
  localOnly: boolean;
};

/** The stages of a command: the lookup on Hugging Face (resolve, model), then the ones mude's install has. */
export type ModelStep = 'resolve' | 'model' | 'download' | 'python' | 'start' | 'enable' | 'disable' | 'remove';

export type ModelTask = {
  id: number;
  command: ModelCommand;
  /** What the command was given: a link or owner/name for add, a name otherwise. */
  target: string;
  /** The model's name, once the command said it. */
  name?: string;
  phase: 'running' | 'done' | 'failed' | 'cancelled';
  step?: ModelStep;
  /** The command's sentence for its current step, in English. */
  message?: string;
  download?: MudeDownload;
  log: string[];
  error?: { message: string; kind?: ModelErrorKind };
};

export type ModelsState = {
  /** On macOS only; elsewhere nothing is run. */
  available: boolean;
  /** What the list was last; unset until the command first answered. */
  models?: DecisionModel[];
  /** Why the list could not be read, in English. */
  problem?: string;
  task?: ModelTask;
};

export type ModelRequest = {
  action: ModelAction;
  /** add: a Hugging Face link or owner/name[@revision]. use, disable, remove: a model's name. */
  target?: string;
  /** add and use: the only judge, or with the judges behind it. */
  localOnly?: boolean;
};
