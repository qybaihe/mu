/**
 * A dialog pi waits on, as the card that asks it. mu's permission question (a `select` whose options are the answers
 * mu said it would offer) reads as the transcript's permission card reads mu's questions: its title and reason worded
 * from mu's codes in the reader's language, the call it asks about, and one button per answer. Any other `select` is
 * its options as buttons; a `confirm` is yes or no. `input` and `editor` are forms and need no card.
 */
import type { DialogAnswer, ViewDialog, ViewPermission } from '@/common/utils/nativeHost';
import { muPermissionWording } from '@/renderer/pages/conversation/Messages/acp/muPermissionWording';
import type {
  PermissionIntent,
  PermissionOperationKind,
} from '@/renderer/pages/conversation/Messages/components/MessagePermission/permissionOptions';

type Translate = (key: string, options?: Record<string, unknown>) => string;
type Has = (key: string) => boolean;

/** One answer the card offers, and what it sends to pi. */
export type DialogChoice = { id: string; label: string; intent: PermissionIntent; answer: DialogAnswer };

export type PermissionCard = {
  title: string;
  description?: string;
  /** The call mu asks about: a command, `edit <path>`, `<tool> <target>`. */
  detail: string;
  operationKind: PermissionOperationKind;
  choices: DialogChoice[];
  /** What an answer decided about the call, said once it went through; undefined to name the answer. */
  decided: (choiceId: string) => string | undefined;
};

const OPERATION: Record<string, PermissionOperationKind> = {
  edit: 'edit',
  outside: 'edit',
  shell: 'execute',
  run: 'execute',
};

const INTENT: Record<string, PermissionIntent> = { once: 'allow-once', session: 'allow-always', deny: 'reject-once' };

/** mu's answers without ids: "once", then "for this conversation" when offered, then "don't allow". */
const positional = (index: number, count: number): PermissionIntent =>
  index === count - 1 ? 'reject-once' : index === 0 ? 'allow-once' : 'allow-always';

export function permissionCard(dialog: ViewDialog, permission: ViewPermission, t: Translate, has: Has): PermissionCard {
  const wording = muPermissionWording(
    {
      mu: {
        kind: permission.kind,
        ...(permission.reason ? { reason: permission.reason } : {}),
        ...(permission.flagCode ? { flagCode: permission.flagCode } : {}),
        ...(permission.grantLabel ? { grantLabel: permission.grantLabel } : {}),
      },
    },
    t,
    has
  );
  // mu's picker title is three lines: what it wants to do, the call, and why it asks.
  const lines = dialog.title.split('\n').map((line) => line.trim());
  const why = lines.length > 2 ? lines.at(-1) : undefined;
  const title = wording?.title ?? (lines[0] || permission.summary);
  const description = wording?.description ?? why;
  const answers = dialog.options ?? permission.answers;
  const choices = answers.map((answer, index): DialogChoice => {
    const answerId = permission.answerIds?.[index];
    const id = answerId ? `mu:${answerId}` : String(index);
    return {
      id,
      label: wording?.answer(id) ?? answer,
      intent: (answerId && INTENT[answerId]) || positional(index, answers.length),
      answer: { value: answer },
    };
  });
  return {
    title,
    ...(description && description !== title ? { description } : {}),
    detail: permission.summary,
    operationKind: OPERATION[permission.kind] ?? 'tool',
    choices,
    decided: (choiceId) => wording?.decided(choiceId, permission.summary),
  };
}

/** The buttons of a `select` that is not mu's permission question, or of a `confirm`. */
export function dialogChoices(dialog: ViewDialog, t: Translate): DialogChoice[] {
  if (dialog.method === 'confirm')
    return [
      { id: 'yes', label: t('mu.native.dialog.yes'), intent: 'allow-once', answer: { confirmed: true } },
      { id: 'no', label: t('mu.native.dialog.no'), intent: 'reject-once', answer: { confirmed: false } },
    ];
  return (dialog.options ?? []).map((option, index) => ({
    id: String(index),
    label: option,
    intent: 'neutral',
    answer: { value: option },
  }));
}
