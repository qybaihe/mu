import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeEditor from './vendor/codeEditor/CodeEditor';
import {
  contentText,
  foldEvents,
  list,
  num,
  record,
  str,
  type Envelope,
  type RecordValue,
  type SessionMeta,
  type SessionSnapshot,
  type TimelineItem,
} from './state.ts';
import './style.css';

const turnLabels: Record<string, string> = {
  chat: 'Chat',
  chat_question: '问答',
  quick_lookup: '快速检索',
  single_edit: '代码修改',
  multi_step_task: '多步任务',
  research: 'Research',
  design_discussion: '方案设计',
  unknown: '默认策略',
};
const beeLabels: Record<string, string> = {
  queued: '排队',
  starting: '启动',
  thinking: '分析中',
  tool: '调用工具',
  retrying: '重试',
  'wrapping-up': '正在收尾',
  done: '完成',
  failed: '失败',
  stopped: '已停止',
  'timed-out': '超时',
};
const seconds = (value: unknown) => `${(num(value) / 1000).toFixed(1)}s`;
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

function Verdict({ item }: { item: TimelineItem }) {
  const d = item.data || {};
  return (
    <details className={`verdict ${item.running ? 'pending' : ''}`}>
      <summary>
        <span className={item.running ? 'spinner' : 'diamond'}>{item.running ? '' : '◇'}</span>
        <span className='muted'>{str(d.by) || item.text}</span>
        <strong>{item.running ? '正在判断任务类型' : turnLabels[str(d.turnType)] || '默认策略'}</strong>
        {!item.running && (
          <>
            <span className='pill'>{str(d.gear) || 'standard'}</span>
            <span className='muted'>{seconds(d.latencyMs)}</span>
          </>
        )}
        <span className='grow' />
        <span className='muted'>
          {d.state === 'late'
            ? '迟到 · 未应用'
            : d.state === 'shadow'
              ? '仅观察'
              : d.state === 'none'
                ? '已降级'
                : '判断详情'}
        </span>
      </summary>
      <div className='verdict-details'>
        {item.running ? (
          <p>先分类，再执行。这里显示模型返回的判断结果，而非推测的思考过程。</p>
        ) : (
          <>
            <p>{str(d.reason)}</p>
            {list(d.answers).map((pair, i) => (
              <div className='answer-row' key={i}>
                <span>{str(list(pair)[0])}</span>
                <code>{str(list(pair)[1])}</code>
              </div>
            ))}
            {list(d.hints).map((hint, i) => (
              <p key={i}>{str(hint)}</p>
            ))}
          </>
        )}
      </div>
    </details>
  );
}

function Message({ item }: { item: TimelineItem }) {
  if (item.type === 'verdict') return <Verdict item={item} />;
  if (item.type === 'tool')
    return (
      <details className='tool-card'>
        <summary>
          <span className={item.running ? 'spinner' : 'tool-mark'}>
            {item.running ? '' : item.data?.isError ? '!' : '✓'}
          </span>
          <strong>{item.text}</strong>
          <code>
            {str(record(item.data?.args).path || record(item.data?.args).command || record(item.data?.args).url).slice(
              0,
              90
            )}
          </code>
          <span className='grow' />
          <small>{item.running ? '执行中' : '已结束'}</small>
        </summary>
        <pre>{pretty(item.data?.args)}</pre>
        <pre>{str(item.data?.result).slice(-24000)}</pre>
      </details>
    );
  if (item.type === 'notice') return <div className='notice'>{item.text}</div>;
  return (
    <article className={`message ${item.type}`}>
      <div className='message-label'>{item.type === 'user' ? '你' : 'KYRN'}</div>
      <div className='message-body'>
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children }) => <span className='link-text'>{children}</span>,
            img: () => <span>[图片附件]</span>,
          }}
        >
          {item.text}
        </Markdown>
      </div>
    </article>
  );
}

function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [current, setCurrent] = useState<SessionSnapshot>();
  const [events, setEvents] = useState<Envelope[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('判断');
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    localStorage.getItem('kyrn.theme') === 'dark' ? 'dark' : 'light'
  );
  const [files, setFiles] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [file, setFile] = useState<{ path: string; text: string; revision: string }>();
  const [draft, setDraft] = useState('');
  const [diff, setDiff] = useState('');
  const [behavior, setBehavior] = useState('steer');
  const [approvalText, setApprovalText] = useState('');
  const activeId = useRef('');
  const incoming = useRef(new Map<string, Envelope[]>());
  const bottom = useRef<HTMLDivElement>(null);
  const view = useMemo(() => foldEvents(events), [events]);
  const approval = view.dialogs[0];
  const busy = view.busy;
  const action = async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('kyrn.theme', theme);
  }, [theme]);
  useEffect(() => {
    const unsubscribe = window.kyrn.subscribe((envelope) => {
      const queue = incoming.current.get(envelope.sessionId) || [];
      queue.push(envelope);
      if (queue.length > 6000) queue.shift();
      incoming.current.set(envelope.sessionId, queue);
      if (envelope.sessionId === activeId.current)
        setEvents((previous) =>
          previous.some((e) => e.sequence === envelope.sequence) ? previous : [...previous, envelope].slice(-6000)
        );
    });
    void window.kyrn
      .request<{ sessions: SessionMeta[]; ready: boolean }>('bootstrap')
      .then((data) => {
        setSessions(data.sessions);
        if (!data.ready) setError('未找到 KYRN CLI，请配置 KYRN_ROOT。');
      })
      .catch((e) => setError(String(e)));
    return unsubscribe;
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [events.length, current?.id]);

  const load = async (id?: string) => {
    if (file && draft !== file.text && !window.confirm('有未保存的代码编辑，放弃后切换任务？')) return;
    setLoading(true);
    try {
      const session = await window.kyrn.request<SessionSnapshot | null>(id ? 'open' : 'create', id ? { id } : {});
      if (!session) return;
      activeId.current = session.id;
      const all = new Map([...session.events, ...(incoming.current.get(session.id) || [])].map((e) => [e.sequence, e]));
      setEvents([...all.values()].sort((a, b) => a.sequence - b.sequence));
      setCurrent(session);
      setFile(undefined);
      setFiles([]);
      setDiff('');
      setSessions((previous) => [session, ...previous.filter((item) => item.id !== session.id)]);
    } finally {
      setLoading(false);
    }
  };
  const send = () =>
    action(async () => {
      if (!current || !text.trim()) return;
      const sent = text;
      setText('');
      try {
        await window.kyrn.request('prompt', { id: current.id, text: sent, behavior });
        setSessions((previous) =>
          previous.map((item) =>
            item.id === current.id && item.title === '新任务' ? { ...item, title: sent.slice(0, 36) } : item
          )
        );
      } catch (e) {
        setText(sent);
        throw e;
      }
    });
  const loadFiles = () =>
    action(async () => {
      if (current) setFiles(await window.kyrn.request<string[]>('files', { id: current.id }));
    });
  const openFile = (path: string) =>
    action(async () => {
      if (!current || (file && draft !== file.text && !window.confirm('放弃未保存的修改？'))) return;
      const result = await window.kyrn.request<{ path: string; text: string; revision: string }>('read', {
        id: current.id,
        path,
      });
      setFile(result);
      setDraft(result.text);
    });
  const control = (name: string, hard: boolean) =>
    action(async () => {
      if (!current || (hard && !window.confirm(`立即停止 ${name}？将保留已获得的结果。`))) return;
      await window.kyrn.request('swarm', { id: current.id, action: hard ? 'kill' : 'stop', name });
    });
  const reply = (fields: RecordValue) =>
    action(async () => {
      if (current && approval)
        await window.kyrn.request('respond', { id: current.id, requestId: approval.id, ...fields });
      setApprovalText('');
    });
  const selectedTitle = sessions.find((item) => item.id === current?.id)?.title || '新的开始';
  const bees = list(view.swarm?.bees).map(record);
  const runningBees = bees.filter(
    (bee) => !['done', 'failed', 'stopped', 'timed-out'].includes(str(bee.status))
  ).length;
  const board = record(view.swarm?.board);

  return (
    <div className='app-shell'>
      <aside className='sidebar'>
        <div className='brand'>
          <span className='logo'>K</span>
          <span>
            KYRN<small>Judgment-first workspace</small>
          </span>
        </div>
        <button className='new-task' disabled={loading} onClick={() => void action(() => load())}>
          ＋ 新建项目任务
        </button>
        <div className='section-label'>
          工作空间 <span>{sessions.length}</span>
        </div>
        <nav>
          {sessions.length === 0 && (
            <p className='empty-sidebar'>
              选择一个本地项目，
              <br />
              开始第一个任务。
            </p>
          )}
          {sessions.map((session) => (
            <button
              className={`session-row ${current?.id === session.id ? 'selected' : ''}`}
              key={session.id}
              disabled={loading}
              onClick={() => void action(() => load(session.id))}
            >
              <span className='session-symbol'>⌘</span>
              <span>
                <strong>{session.title}</strong>
                <small>{session.cwd.split('/').pop()}</small>
              </span>
            </button>
          ))}
        </nav>
        <div className='sidebar-footer'>
          <div className='local-badge'>
            <i /> 本地运行 · 仅 KYRN 内核
          </div>
          <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
            {theme === 'light' ? '切换深色外观' : '切换浅色外观'}
          </button>
          <small>KYRN 0.1</small>
        </div>
      </aside>
      <main className='conversation'>
        <header className='topbar'>
          <div>
            <strong>{selectedTitle}</strong>
            <small>{current?.cwd || '你的代码、任务和判断，在同一个工作区。'}</small>
          </div>
          <span className={`live-status ${busy ? 'active' : ''}`}>
            <i />
            {loading ? '连接本地内核' : view.phase}
          </span>
        </header>
        <div className='timeline'>
          {view.items.length === 0 ? (
            <div className='welcome'>
              <div className='welcome-mark'>K</div>
              <p className='eyebrow'>LESS CONTEXT. BETTER DECISIONS.</p>
              <h1>
                把复杂的工作，
                <br />
                交给清晰的判断。
              </h1>
              <p>
                判定器判断任务，KYRN 组织执行。
                <br />
                每一次路由、工具调用和蜂群进展，都在眼前。
              </p>
              <div className='suggestions'>
                {[
                  '分析项目结构，找出最值得改善的地方',
                  '检查最近的修改并提出代码审查意见',
                  '从不同角度调查一个难复现的问题',
                ].map((prompt, i) => (
                  <button key={prompt} onClick={() => setText(prompt)}>
                    <span>0{i + 1}</span>
                    {prompt}
                    <b>↗</b>
                  </button>
                ))}
              </div>
              {!current && (
                <button className='primary' disabled={loading} onClick={() => void action(() => load())}>
                  选择本地项目
                </button>
              )}
            </div>
          ) : (
            view.items.map((item) => <Message key={item.id} item={item} />)
          )}
          <div ref={bottom} />
        </div>
        <div className='composer-wrap'>
          {error && (
            <div className='error' role='alert'>
              {error}
              <button onClick={() => setError('')}>关闭</button>
            </div>
          )}
          <div className='composer'>
            <textarea
              aria-label='任务消息'
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={current ? '描述任务，或输入 /status、/doctor、/agents…' : '先选择项目，再把任务交给 KYRN'}
              disabled={!current}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className='composer-actions'>
              <select
                aria-label='主模型'
                disabled={!current || busy}
                value={
                  current?.state
                    ? `${str(record(current.state.model).provider)}/${str(record(current.state.model).id)}`
                    : ''
                }
                onChange={(e) => {
                  const model = current?.models.find((m) => `${m.provider}/${m.id}` === e.target.value);
                  if (current && model)
                    void action(async () => {
                      const state = await window.kyrn.request<RecordValue>('model', {
                        id: current.id,
                        provider: model.provider,
                        modelId: model.id,
                      });
                      setCurrent({ ...current, state });
                    });
                }}
              >
                <option value=''>使用 CLI 默认模型</option>
                {current?.models.map((model) => (
                  <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                    {model.name || model.id}
                  </option>
                ))}
              </select>
              <span className='grow' />
              {busy && (
                <>
                  <select aria-label='插话方式' value={behavior} onChange={(e) => setBehavior(e.target.value)}>
                    <option value='steer'>立即插话</option>
                    <option value='followUp'>排队执行</option>
                  </select>
                  <button
                    onClick={() =>
                      void action(async () => {
                        await window.kyrn.request('abort', { id: current?.id });
                      })
                    }
                  >
                    停止
                  </button>
                </>
              )}
              <button
                className='send'
                aria-label='发送任务'
                disabled={!current || !text.trim()}
                onClick={() => void send()}
              >
                ↑
              </button>
            </div>
          </div>
          <div className='composer-note'>
            <span>判断模型由 KYRN 配置决定 · 登录态保留在本地</span>
            <span>Enter 发送 · Shift Enter 换行</span>
          </div>
        </div>
      </main>
      <aside className='work-panel'>
        <div className='work-header'>
          工作面板 <span className='pill'>LIVE</span>
        </div>
        <div className='tabs'>
          {['判断', '蜂群', '代码', '变更'].map((name) => (
            <button
              key={name}
              className={tab === name ? 'selected' : ''}
              onClick={() => {
                setTab(name);
                if (name === '代码') void loadFiles();
                if (name === '变更' && current)
                  void action(async () => {
                    const result = await window.kyrn.request<{ working: string; staged: string }>('diff', {
                      id: current.id,
                    });
                    setDiff(`工作区修改\n${result.working || '无已跟踪文件修改'}\n\n已暂存\n${result.staged || '无'}`);
                  });
              }}
            >
              {name}
              {name === '蜂群' && runningBees > 0 && <b>{runningBees}</b>}
            </button>
          ))}
        </div>
        {tab === '判断' && (
          <div className='panel-content'>
            <div className='judge-hero'>
              <span className='eyebrow'>DECISION LAYER</span>
              <h2>{view.judge}</h2>
              <p>实际判定、耗时与回退路径。判断过程与主模型上下文分离。</p>
            </div>
            <div className='metrics'>
              <div>
                <strong>{view.decisions.length}</strong>
                <span>判断记录</span>
              </div>
              <div>
                <strong>{view.decisions.filter((d) => d.source === 'fallback').length}</strong>
                <span>回退 / 观察</span>
              </div>
            </div>
            <h3>决策时间线</h3>
            {view.decisions.length === 0 && <p className='muted'>发送任务后，这里会展示真实判断结果。</p>}
            {[...view.decisions]
              .reverse()
              .slice(0, 40)
              .map((d, i) => (
                <details className='decision-row' key={str(d.id) || i}>
                  <summary>
                    <i />
                    <span>
                      <strong>{str(d.specId)}</strong>
                      <small>
                        {str(d.providerId)} · {seconds(d.latencyMs)}
                      </small>
                    </span>
                    <span className='pill'>{str(d.source)}</span>
                  </summary>
                  <pre>{pretty({ outcome: d.outcome, reason: d.reason, answers: d.answers })}</pre>
                </details>
              ))}
          </div>
        )}
        {tab === '蜂群' && (
          <div className='panel-content'>
            <div className='judge-hero'>
              <span className='eyebrow'>SHARED INTELLIGENCE</span>
              <h2>{bees.length ? `${runningBees} 只蜂正在工作` : '独立执行，选择性共享'}</h2>
              <p>{str(view.swarm?.title) || '复杂任务启动蜂群后，每个成员的进展与信息传播会显示在这里。'}</p>
            </div>
            {bees.map((bee) => (
              <div className='bee' key={str(bee.name)}>
                <div className='bee-heading'>
                  <strong>{str(bee.name)}</strong>
                  <span className='pill'>{beeLabels[str(bee.status)] || str(bee.status)}</span>
                </div>
                <small>
                  {str(bee.role)} · {str(bee.model)}
                </small>
                <p>{str(record(bee.tool).summary) || str(bee.said) || '等待下一条执行事件'}</p>
                <div className='bee-stats'>
                  <span>{num(bee.toolCalls)} 次工具</span>
                  <span>
                    发布 {num(bee.published)} / 收到 {num(bee.received)}
                  </span>
                </div>
                {num(bee.quietMs) > 0 && <div className='notice'>{seconds(bee.quietMs)} 未收到新事件</div>}
                {!['done', 'failed', 'stopped', 'timed-out'].includes(str(bee.status)) && (
                  <div className='bee-actions'>
                    <button onClick={() => void control(str(bee.name), false)}>要求收尾</button>
                    <button onClick={() => void control(str(bee.name), true)}>立即停止</button>
                  </div>
                )}
                <details>
                  <summary>执行轨迹</summary>
                  {list(bee.recent).map((line, i) => (
                    <p key={i}>{str(record(line).text)}</p>
                  ))}
                </details>
              </div>
            ))}
            <h3>信息传播</h3>
            <p className='muted'>
              {num(board.notes)} 条发现 · {num(board.deliveries)} 次投递
            </p>
            {list(board.latest).map((note, i) => {
              const n = record(note);
              return (
                <div className='board-note' key={i}>
                  <small>
                    {str(n.bee)} → {list(n.to).join('、') || '共享板'}
                  </small>
                  <p>{str(n.text)}</p>
                </div>
              );
            })}
          </div>
        )}
        {tab === '代码' && (
          <div className='code-panel'>
            {file ? (
              <>
                <div className='file-toolbar'>
                  <button
                    onClick={() => {
                      if (draft === file.text || window.confirm('放弃未保存修改？')) setFile(undefined);
                    }}
                  >
                    ←
                  </button>
                  <span title={file.path}>{file.path}</span>
                  <button
                    disabled={draft === file.text}
                    onClick={() =>
                      void action(async () => {
                        const saved = await window.kyrn.request<typeof file>('save', {
                          id: current?.id,
                          path: file.path,
                          text: draft,
                          revision: file.revision,
                        });
                        setFile(saved);
                      })
                    }
                  >
                    保存{draft !== file.text ? ' *' : ''}
                  </button>
                </div>
                <CodeEditor theme={theme} value={draft} onChange={setDraft} fileName={file.path} />
              </>
            ) : (
              <>
                <div className='file-search'>
                  <input
                    aria-label='搜索文件'
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder='搜索项目文件'
                  />
                  <button onClick={() => void loadFiles()}>刷新</button>
                </div>
                <div className='file-list'>
                  {files
                    .filter((path) => path.toLowerCase().includes(filter.toLowerCase()))
                    .map((path) => (
                      <button key={path} onClick={() => void openFile(path)}>
                        <span>⌘</span>
                        {path}
                      </button>
                    ))}
                </div>
              </>
            )}
          </div>
        )}
        {tab === '变更' && (
          <div className='panel-content diff'>
            {diff ? (
              diff.split('\n').map((line, i) => (
                <div key={i} className={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''}>
                  {line || ' '}
                </div>
              ))
            ) : (
              <p className='muted'>选择任务后查看工作区与暂存区 Diff。未跟踪文件请在代码面板查看。</p>
            )}
          </div>
        )}
      </aside>
      {approval && (
        <div className='modal-backdrop'>
          <section className='approval' role='dialog' aria-modal='true'>
            <p className='eyebrow'>需要你的决定</p>
            <h2>{str(approval.title)}</h2>
            <p>{str(approval.message)}</p>
            {['input', 'editor'].includes(str(approval.method)) && (
              <textarea
                value={approvalText}
                onChange={(e) => setApprovalText(e.target.value)}
                placeholder={str(approval.placeholder || approval.prefill)}
              />
            )}
            <div className='approval-actions'>
              <button onClick={() => void reply({ cancelled: true })}>取消 / 拒绝</button>
              {approval.method === 'select' ? (
                list(approval.options).map((option) => (
                  <button key={str(option)} onClick={() => void reply({ value: option })}>
                    {str(option)}
                  </button>
                ))
              ) : (
                <button
                  className='primary'
                  onClick={() =>
                    void reply(approval.method === 'confirm' ? { confirmed: true } : { value: approvalText })
                  }
                >
                  确认
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
