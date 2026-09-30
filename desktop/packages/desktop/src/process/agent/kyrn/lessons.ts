import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { KyrnError } from '../../../common/kyrn/errors';
import {
  flatLesson,
  inScope,
  parseLessons,
  type LessonEdit,
  type LessonLine,
  type LessonsView,
  type StoredLesson,
} from '../../../common/kyrn/lessons';
import { parseObject, readOptional } from './config/files';
import { configPath } from './naming';
import { asRecord, text } from './piRpc';

/*
 * The lessons tab's side of mu's experience library (common/kyrn/lessons.ts). The harness appends to the same file
 * from every session it runs, so this side never rewrites it either: an edit or a retirement is one more line, and the
 * file is read afresh for every answer.
 */

const SESSION_ID = /^[a-f\d-]{36}$/;

/**
 * Where mu keeps its lessons: `features.memory.path` in mu.json when it names a file by its full path (the harness's
 * `memory.path` option), else `<agentDir>/mu/lessons.jsonl`. A relative path is read by each session from the folder
 * it runs in, which is no one file the app could show, so it is left to the harness.
 */
export function lessonsPath(agentDir: string): string {
  let configured = '';
  try {
    const features = asRecord(parseObject(readOptional(configPath(agentDir))).features);
    configured = text(asRecord(features.memory).path).trim();
  } catch {
    // An unreadable mu.json is for the settings page to report; the lessons are where they are by default.
  }
  return configured && isAbsolute(configured) ? configured : join(agentDir, 'mu', 'lessons.jsonl');
}

/** Every lesson in the file, folded. A missing file holds none; one that cannot be read names itself (`unreadable`). */
export function readLessonsFile(path: string): StoredLesson[] {
  return parseLessons(readOptional(path));
}

/** True when the file has content that does not end with a newline: whatever is appended would join its last line. */
function endsOpen(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Appends one line and never touches what is there. A file whose last line has no newline gets one first, so no two
 * lines run together; both go out in one write, which another process's append lands before or after, never inside.
 */
export function appendLesson(path: string, line: LessonLine): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${endsOpen(path) ? '\n' : ''}${JSON.stringify(line)}\n`);
  } catch (error) {
    throw new KyrnError('unwritable', error instanceof Error ? error.message : String(error), { file: path });
  }
}

/** The folder a conversation's project lessons belong to, and every spelling of it a lesson may carry. */
export type LessonsProject = { folder: string; places: string[] };

/**
 * Where a conversation's project lessons live. The harness scopes a lesson to the folder its session runs in, which
 * the adapter keeps in its record of the session (`<sessions>/<id>.json`: the workspace's real path). Before a session
 * has started there is no record; then it is the conversation's workspace, as given and as its real path.
 */
export function lessonsProject(sessions: string, sessionId: string, workspace: string): LessonsProject {
  const places: string[] = [];
  const add = (path: string) => {
    if (path && !places.includes(path)) places.push(path);
  };
  if (SESSION_ID.test(sessionId)) {
    try {
      add(text(asRecord(JSON.parse(readFileSync(join(sessions, `${sessionId}.json`), 'utf8'))).cwd));
    } catch {
      // No record yet, or one that does not parse: the workspace says where.
    }
  }
  if (workspace) {
    try {
      add(realpathSync(workspace));
    } catch {
      // A folder that is gone keeps the name it had.
    }
    add(workspace);
  }
  return { folder: places[0] ?? '', places };
}

/** The lessons tab's reads and its two changes. */
export class LessonsStore {
  private agentDir: string;
  constructor(agentDir: string) {
    this.agentDir = agentDir;
  }

  /** The lessons of the project and those for everywhere, in any state, in the order the file has them. */
  view(project: LessonsProject): LessonsView {
    const lessons = readLessonsFile(lessonsPath(this.agentDir)).filter((lesson) => inScope(lesson, project.places));
    return { project: project.folder, lessons };
  }

  /**
   * A new text (`{ id, lesson, updated }`) or a retirement (`{ id, status: "retired", updated }`) for a lesson of this
   * project that is in use, appended as one line; then the lessons as they are now. The same text again writes nothing.
   */
  change(project: LessonsProject, change: LessonEdit, now: Date = new Date()): LessonsView {
    const request = asRecord(change);
    const id = text(request.id);
    if (!id.trim() || id.length > 256) throw new KyrnError('invalid', 'Invalid lesson id');
    if (request.action !== 'edit' && request.action !== 'retire') throw new KyrnError('invalid', 'Invalid change');
    const path = lessonsPath(this.agentDir);
    const lesson = readLessonsFile(path).find((each) => each.id === id);
    if (!lesson || !inScope(lesson, project.places)) throw new KyrnError('invalid', 'No such lesson in this project');
    if (lesson.status !== 'active') throw new KyrnError('invalid', 'The lesson is not in use');
    const updated = now.toISOString();
    if (request.action === 'retire') {
      appendLesson(path, { id, status: 'retired', updated });
    } else {
      const words = flatLesson(text(request.lesson));
      if (!words) throw new KyrnError('invalid', 'A lesson cannot be empty');
      if (words !== lesson.lesson) appendLesson(path, { id, lesson: words, updated });
    }
    return this.view(project);
  }
}
