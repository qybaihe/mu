import { beforeAll, describe, expect, it } from 'vitest';
import { createInstance, type TFunction } from 'i18next';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import zhCommon from '@/renderer/services/i18n/locales/zh-CN/common.json';
import twCommon from '@/renderer/services/i18n/locales/zh-TW/common.json';
import { parseBeeActivity, parseBeeError, type BeeActivity, type BeeErrorState } from '@/common/kyrn/hive';
import { formatDuration } from '@/renderer/services/i18n/format';
import {
  beeActivityText,
  beeErrorText,
  swarmProgressText,
  swarmTitleText,
} from '@/renderer/pages/conversation/KyrnPanel/Hive/codes';

let en: TFunction;
let zh: TFunction;
let tw: TFunction;
beforeAll(async () => {
  const make = async (lng: string, common: unknown) => {
    const i18n = createInstance();
    await i18n.init({ lng, resources: { [lng]: { translation: { common } } }, interpolation: { escapeValue: false } });
    return i18n.t;
  };
  en = await make('en-US', enCommon);
  zh = await make('zh-CN', zhCommon);
  tw = await make('zh-TW', twCommon);
});

const line = (code: string | undefined, params: Record<string, string | number> = {}, text = 'english'): BeeActivity =>
  parseBeeActivity([{ at: 1, text, ...(code ? { code } : {}), params }])[0];
const failed = (bee: Record<string, unknown>): BeeErrorState => parseBeeError(bee);

describe('Sub-agent sentences by code', () => {
  it('words a delegate run title by its code with plurals, and keeps a hive goal as it is', () => {
    const tasks = { title: '3 tasks', titleCode: { code: 'delegate_tasks', params: { count: 3 } } };
    expect(swarmTitleText(en, tasks)).toBe('3 tasks');
    expect(swarmTitleText(zh, tasks)).toBe('3 个任务');
    const chain = { title: 'a chain of 1 step', titleCode: { code: 'delegate_chain', params: { count: 1 } } };
    expect(swarmTitleText(en, chain)).toBe('a chain of 1 step');
    expect(swarmTitleText(zh, chain)).toBe('1 步的任务链');
    expect(swarmTitleText(zh, { title: 'Investigate cache behavior' })).toBe('Investigate cache behavior');
    // An unknown code, or a count that is not one, leaves the English as written.
    expect(swarmTitleText(zh, { title: 'x', titleCode: { code: 'future', params: { count: 2 } } })).toBe('x');
    expect(swarmTitleText(zh, { title: 'y', titleCode: { code: 'delegate_tasks', params: { count: 'two' } } })).toBe(
      'y'
    );
  });

  it('words the routing step before the first snapshot, else shows the output as it is', () => {
    const progress = { code: 'choosing_roles', params: { count: 1 } };
    expect(swarmProgressText(en, progress, 'english')).toBe(
      'choosing a role, a model and a thinking level for 1 subagent…'
    );
    expect(swarmProgressText(zh, { ...progress, params: { count: 3 } }, 'english')).toBe(
      '正在为 3 个子代理选择角色、模型和思考强度…'
    );
    expect(swarmProgressText(zh, undefined, 'plain swarm view')).toBe('plain swarm view');
    expect(swarmProgressText(zh, { code: 'other', params: { count: 3 } }, 'as is')).toBe('as is');
  });

  it('words every activity code and passes data through unchanged', () => {
    expect(beeActivityText(en, line('notes_received', { count: 1 }))).toBe('← 1 note from the others');
    expect(beeActivityText(zh, line('notes_received', { count: 2 }))).toBe('← 收到其他蜂群成员的 2 条发现');
    expect(beeActivityText(en, line('late_notes', { count: 3 }))).toBe('← last call: 3 late notes');
    expect(beeActivityText(zh, line('asked_findings'))).toBe('← 被问到目前有哪些发现');
    expect(beeActivityText(zh, line('told_wrap_up'))).toBe('← 被要求收尾并提交报告');
    expect(beeActivityText(zh, line('tool_call', { tool: 'bash', summary: 'bash npm test' }))).toBe('bash npm test');
    expect(beeActivityText(zh, line('tool_failed', { tool: 'read' }))).toBe('read 失败');
    expect(
      beeActivityText(zh, line('retry', { attempt: 2, maxAttempts: 3, message: '429 Too Many Requests' }), 'zh-CN')
    ).toBe('重试 2/3：429 Too Many Requests');
    expect(beeActivityText(en, line('model_error', { message: 'overloaded' }))).toBe('model error: overloaded');
    // The harness's own words for a request without a provider message are not data.
    expect(beeActivityText(zh, line('model_error', { message: 'the model request was aborted' }))).toBe(
      '模型错误：模型请求已中止'
    );
    expect(beeActivityText(zh, line('compacting'))).toBe('正在压缩上下文');
  });

  it('falls back to the English line without a code, with an unknown code, or with params that do not fit', () => {
    expect(beeActivityText(zh, line(undefined, {}, '← 2 notes from the others'))).toBe('← 2 notes from the others');
    expect(beeActivityText(zh, line('future_code', {}, 'something new'))).toBe('something new');
    expect(beeActivityText(zh, line('notes_received', {}, '← ? notes'))).toBe('← ? notes');
    expect(beeActivityText(zh, line('retry', { attempt: 1 }, 'retry 1/?: x'))).toBe('retry 1/?: x');
  });

  it('words why a bee ended, with durations in the app language', () => {
    const zhDuration = (ms: number) => formatDuration(ms, 'zh-CN', 'short');
    expect(beeErrorText(zh, failed({ error: 'the run was cancelled', errorCode: 'cancelled' }))).toBe('运行已取消');
    expect(beeErrorText(zh, failed({ error: 'stopped by the user', errorCode: 'stopped_by_user' }))).toBe(
      '已被用户停止'
    );
    expect(beeErrorText(zh, failed({ error: 'ended by the user', errorCode: 'ended_by_user' }))).toBe('已被用户结束');
    expect(
      beeErrorText(
        en,
        failed({
          error: 'no sign of life from the model for 5m00s',
          errorCode: 'stalled',
          errorParams: { what: 'model', seconds: 300 },
        }),
        'en-US'
      )
    ).toBe('no response from the model for 5 min');
    expect(
      beeErrorText(
        zh,
        failed({ error: 'x', errorCode: 'stalled', errorParams: { what: 'tool', tool: 'bash', seconds: 900 } }),
        'zh-CN'
      )
    ).toBe(`bash 调用已 ${zhDuration(900_000)} 没有任何动静`);
    expect(
      beeErrorText(en, failed({ error: 'x', errorCode: 'time_budget', errorParams: { minutes: 10 } }), 'en-US')
    ).toBe('time budget of 10 min reached');
    expect(
      beeErrorText(
        zh,
        failed({
          error: 'not started: the step before it ("scan") did not finish',
          errorCode: 'chain_broken',
          errorParams: { step: 'scan' },
        })
      )
    ).toBe('未开始：前一步（「scan」）没有完成');
  });

  it('says a missed report whole, naming the wrap-up it followed by its own code', () => {
    const bee = {
      error: 'time budget of 10 min reached; no report within 90s of being asked',
      errorCode: 'no_report_in_time',
      errorParams: { seconds: 90, after: 'time_budget' },
      wrapUp: { at: 1, reason: 'time budget of 10 min reached', code: 'time_budget', params: { minutes: 10 } },
    };
    expect(beeErrorText(en, failed(bee), 'en-US')).toBe(
      'time budget of 10 min reached; no report within 1 min, 30 sec of being asked'
    );
    expect(beeErrorText(zh, failed(bee), 'zh-CN')).toBe(
      `已用完 ${formatDuration(600_000, 'zh-CN', 'short')} 的时间预算；被要求后 ${formatDuration(90_000, 'zh-CN', 'short')} 内没有提交报告`
    );
    // Without the wrap-up in the snapshot, the budget is not repeated.
    expect(beeErrorText(en, failed({ ...bee, wrapUp: undefined }), 'en-US')).toBe(
      'time budget reached; no report within 1 min, 30 sec of being asked'
    );
    expect(
      beeErrorText(zh, failed({ ...bee, errorParams: { seconds: 90, after: 'stopped_by_user' }, wrapUp: undefined }))
    ).toMatch(/^已被用户停止；/);
    // A wrap-up this desktop does not know, or none named at all: the English stands.
    expect(beeErrorText(zh, failed({ ...bee, errorParams: { seconds: 90, after: 'future' } }))).toBe(bee.error);
    expect(beeErrorText(zh, failed({ ...bee, errorParams: { seconds: 90 } }))).toBe(bee.error);
  });

  it('keeps the message of a model or a process as data after the translated reason', () => {
    expect(
      beeErrorText(
        zh,
        failed({
          error: 'Connection error.',
          errorCode: 'model_error',
          errorParams: { message: 'Connection error.', stopReason: 'error' },
        })
      )
    ).toBe('模型请求失败：Connection error.');
    expect(
      beeErrorText(
        zh,
        failed({
          error: 'the model request was aborted',
          errorCode: 'model_error',
          errorParams: { message: 'the model request was aborted', stopReason: 'aborted' },
        })
      )
    ).toBe('模型请求已中止');
    expect(
      beeErrorText(
        zh,
        failed({
          error: 'Request was aborted.',
          errorCode: 'model_error',
          errorParams: { message: 'Request was aborted.', stopReason: 'aborted' },
        })
      )
    ).toBe('模型请求已中止：Request was aborted.');
    expect(
      beeErrorText(
        zh,
        failed({
          error: 'the model request kept failing',
          errorCode: 'retries_exhausted',
          errorParams: { message: 'the model request kept failing' },
        })
      )
    ).toBe('模型请求多次重试后仍然失败');
    expect(
      beeErrorText(
        en,
        failed({ error: '503 upstream', errorCode: 'retries_exhausted', errorParams: { message: '503 upstream' } })
      )
    ).toBe('the model request kept failing: 503 upstream');
    expect(
      beeErrorText(
        zh,
        failed({
          error: 'sub-agent exited with code 1 before it finished: Error: no model configured',
          errorCode: 'exited_early',
          errorParams: { exitCode: 1 },
        })
      )
    ).toBe('子代理在完成前退出，退出码 1：Error: no model configured');
    expect(
      beeErrorText(
        zh,
        failed({
          error: 'sub-agent was ended by SIGTERM before it finished',
          errorCode: 'exited_early',
          errorParams: { signal: 'SIGTERM' },
        })
      )
    ).toBe('子代理在完成前被 SIGTERM 终止');
    expect(
      beeErrorText(
        en,
        failed({
          error: 'sub-agent was ended by a signal before it finished',
          errorCode: 'exited_early',
          errorParams: { signal: 'unknown' },
        })
      )
    ).toBe('subagent was stopped by a signal before it finished');
    expect(
      beeErrorText(zh, failed({ error: 'spawn ENOENT', errorCode: 'error', errorParams: { message: 'spawn ENOENT' } }))
    ).toBe('spawn ENOENT');
  });

  it('says the same in Traditional Chinese', () => {
    expect(beeActivityText(tw, line('notes_received', { count: 2 }))).toBe('← 收到其他蜂群成員的 2 則發現');
    expect(swarmProgressText(tw, { code: 'choosing_roles', params: { count: 2 } }, 'english')).toBe(
      '正在為 2 個子代理選擇角色、模型和思考強度…'
    );
    expect(beeErrorText(tw, failed({ error: 'x', errorCode: 'chain_broken', errorParams: { step: 'scan' } }))).toBe(
      '未開始：前一步（「scan」）沒有完成'
    );
  });

  it('shows the English as written for old rows and codes it does not know', () => {
    expect(beeErrorText(zh, failed({ error: 'the run was cancelled' }))).toBe('the run was cancelled');
    expect(beeErrorText(zh, failed({ error: 'future reason', errorCode: 'future' }))).toBe('future reason');
    expect(beeErrorText(zh, failed({ error: 'no sign of life', errorCode: 'stalled', errorParams: {} }))).toBe(
      'no sign of life'
    );
    // An exit worded some other way keeps its detail by staying English.
    expect(
      beeErrorText(
        zh,
        failed({ error: 'child crashed: boom', errorCode: 'exited_early', errorParams: { exitCode: 2 } })
      )
    ).toBe('child crashed: boom');
  });
});
