import React, { useEffect, useRef, useState } from 'react';
import { Button, Modal, Tag } from '@arco-design/web-react';
import { Plus } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import {
  KEY_PROVIDERS,
  LEGACY_PROVIDERS,
  isSubscriptionProvider,
  type SubscriptionProvider,
} from '@/common/kyrn/login';
import {
  ENDPOINT_TYPES,
  PROVIDER_ID,
  RESERVED_PROVIDER_IDS,
  suggestProviderId,
  type AvailableModels,
  type ProviderSettings,
} from '@/common/kyrn/models';
import type { KyrnSettings } from '@/common/kyrn/types';
import ProviderMark from '@renderer/components/brand/ProviderMark';
import { providerDisplayName } from '@/renderer/utils/model/providerName';
import {
  consumePendingDeepLink,
  subscribePendingDeepLink,
  type DeepLinkAddProviderDetail,
} from '@renderer/hooks/system/useDeepLink';
import AccountDetail from '../accounts/AccountDetail';
import { providerName } from '../accounts/LoginWaiting';
import { useSubscriptionLogin } from '../accounts/useSubscriptionLogin';
import type { Draft } from '../draft';
import ProviderEditor from './ProviderEditor';
import {
  blankProvider,
  camel,
  customProviderName,
  endpointOfLink,
  freeProviderId,
  providerProblems,
} from './endpoints';
import { EndpointMark, ProviderHead, RemoveMenu, StatusDot, type DotState } from './parts';
import { markRemoved } from './removed';
import styles from './providers.module.css';

type Selection =
  | { kind: 'account'; provider: SubscriptionProvider }
  | { kind: 'custom'; index: number }
  | { kind: 'foreign' | 'builtin'; id: string };

type ProviderManagerProps = {
  draft: Draft;
  base: KyrnSettings;
  available: AvailableModels;
  /** A change to the draft's models: providers, hand-written entries, the startup model. */
  onModels: (patch: Partial<KyrnSettings['models']>) => void;
  /** A key typed for a provider, and the id change of a provider that is not saved yet. */
  onKeys: (keys: Record<string, string>) => void;
  /** Reported providers removed on this screen, which the snapshot of mu's last connection still lists. */
  hidden: ReadonlySet<string>;
  /** Between the heading and the list: why models.json cannot be edited, when it cannot. */
  children?: React.ReactNode;
};

const comparable = ({ key: _key, keySet: _set, headerNames: _names, ...rest }: ProviderSettings) =>
  JSON.stringify(rest);

/**
 * Every provider in one place: the subscriptions to sign in to on top, the endpoints set up here below them, then
 * hand-written models.json entries and whatever else the running mu reported. The list is on the left, the chosen
 * one on the right. Signing in and out take effect at once; everything else is a change to the draft, saved by the
 * save bar, and a provider is removed from its more-actions menu after a question.
 */
export default function ProviderManager(props: ProviderManagerProps) {
  const { draft, base, available, onModels, onKeys, hidden, children } = props;
  const { t } = useTranslation();
  const [modal, modalHolder] = Modal.useModal();
  const flow = useSubscriptionLogin();
  const { providers, foreign, commented, problem, defaults } = draft.settings.models;
  const readOnly = commented || Boolean(problem);
  const [selection, setSelection] = useState<Selection>();

  const saved = new Map(base.models.providers.map((provider) => [provider.id, provider]));
  const own = new Set([...providers.map((provider) => provider.id), ...foreign.map((entry) => entry.id)]);
  // Until a removal is saved, its entry is still in models.json: a new provider under that id would be read as an
  // edit of it (with its key and headers), so every id on disk stays taken.
  const onDisk = [
    ...base.models.providers.map((provider) => provider.id),
    ...base.models.foreign.map((entry) => entry.id),
  ];
  const offered = new Set<string>(flow.offered);
  const shown = available.providers.filter((provider) => !hidden.has(provider.id));
  // Whatever the running mu reported that is neither a subscription listed above nor an entry of models.json:
  // mostly providers whose API key is in the environment. A subscription id reported that way (Claude or Grok with
  // an API key) is shown on its subscription row. A subscription-only sign-in no longer offered (ChatGPT through
  // Codex) shows as an account while it is signed in, never as a provider of its own; one whose id also takes a key
  // (Anthropic) is a provider like any other when nobody is signed in to it.
  const builtin = shown.filter(
    (provider) =>
      !own.has(provider.id) &&
      !offered.has(provider.id) &&
      !(
        LEGACY_PROVIDERS.includes(provider.id as SubscriptionProvider) &&
        !KEY_PROVIDERS.includes(provider.id as SubscriptionProvider)
      )
  );
  const reported = available.providers.map((entry) => entry.id).filter((id) => !saved.has(id));
  // A subscription-only id reported while signed out is a snapshot from before a sign-out: not usable.
  const byKey = (provider: SubscriptionProvider) =>
    flow.account(provider) || !KEY_PROVIDERS.includes(provider)
      ? undefined
      : shown.find((entry) => entry.id === provider);

  // Nothing chosen yet: a sign-in that is running (it may be waiting on a question), else the first endpoint, else
  // the first subscription. The last two are known before who is signed in is read, so the pane does not jump then.
  const firstAccount: Selection | undefined = flow.offered[0]
    ? { kind: 'account', provider: flow.offered[0] }
    : undefined;
  const signingIn = flow.running ? flow.login?.provider : undefined;
  const fallback: Selection | undefined =
    signingIn && isSubscriptionProvider(signingIn)
      ? { kind: 'account', provider: signingIn }
      : providers.length
        ? { kind: 'custom', index: 0 }
        : firstAccount;
  // A choice that is gone (the draft was discarded, the entry removed) falls back too.
  const exists = (chosen: Selection) =>
    chosen.kind === 'account'
      ? flow.offered.includes(chosen.provider)
      : chosen.kind === 'custom'
        ? chosen.index < providers.length
        : (chosen.kind === 'foreign' ? foreign : builtin).some((entry) => entry.id === chosen.id);
  const current = selection && exists(selection) ? selection : fallback;

  const takenFor = (index: number) =>
    new Set([
      ...providers.filter((_, i) => i !== index).map((other) => other.id),
      ...foreign.map((entry) => entry.id),
      ...onDisk,
      ...reported,
    ]);
  const add = () => {
    const taken = new Set([...own, ...onDisk, ...builtin.map((provider) => provider.id), ...flow.offered]);
    onModels({ providers: [...providers, blankProvider(freeProviderId(taken))] });
    setSelection({ kind: 'custom', index: providers.length });
  };
  // A mu:// add-provider link: a new provider filled from it, unsaved like one added by hand, with the id its name
  // suggests when the editor would accept that id.
  const addFromLink = (link: DeepLinkAddProviderDetail) => {
    const taken = new Set([...takenFor(providers.length), ...flow.offered]);
    const name = link.name?.trim() ?? '';
    const suggested = suggestProviderId(name);
    const id =
      PROVIDER_ID.test(suggested) && !RESERVED_PROVIDER_IDS.has(suggested) && !taken.has(suggested)
        ? suggested
        : freeProviderId(taken);
    onModels({
      providers: [
        ...providers,
        { ...blankProvider(id), name, api: endpointOfLink(link.platform), baseUrl: link.base_url?.trim() ?? '' },
      ],
    });
    if (link.api_key) onKeys({ ...draft.providerKeys, [id]: link.api_key });
    setSelection({ kind: 'custom', index: providers.length });
  };
  // The link waits for this page: taken when the page opens, or at once when it is already open. Not while models.json
  // cannot be written, as the add button is not; the page says why.
  const takeLink = useRef<((link: DeepLinkAddProviderDetail) => void) | undefined>(undefined);
  useEffect(() => {
    takeLink.current = readOnly ? undefined : addFromLink;
  });
  useEffect(() => {
    const take = () => {
      const link = consumePendingDeepLink();
      if (link) takeLink.current?.(link);
    };
    take();
    return subscribePendingDeepLink(take);
  }, []);
  const replace = (index: number, next: ProviderSettings) => {
    const previous = providers[index];
    if (previous.id !== next.id && previous.id in draft.providerKeys) {
      // The typed key follows its provider to the new id.
      const { [previous.id]: value, ...others } = draft.providerKeys;
      onKeys({ ...others, [next.id]: value });
    }
    onModels({ providers: providers.map((provider, i) => (i === index ? next : provider)) });
  };
  // Removing the provider new sessions start with leaves no startup model rather than one that cannot load. An
  // entry under a built-in or subscription id only rerouted that provider, which stays, and so does the model.
  const clearsDefault = (id: string) =>
    Boolean(id) && defaults.provider === id && !RESERVED_PROVIDER_IDS.has(id) && !isSubscriptionProvider(id);
  const withoutDefault = (id: string) =>
    clearsDefault(id) ? { defaults: { ...defaults, provider: '', model: '' } } : {};
  const ask = (name: string, text: string, isDefault: boolean, onOk: () => void) =>
    modal.confirm?.({
      title: t('mu.providers.removeTitle', { name }),
      content: (
        <div className={styles.confirm}>
          <p>{text}</p>
          {isDefault ? <p>{t('mu.providers.removeDefault')}</p> : null}
        </div>
      ),
      okText: t('mu.providers.remove'),
      cancelText: t('common.cancel'),
      okButtonProps: { status: 'danger' },
      onOk,
    });
  const removeCustom = (index: number) => {
    const provider = providers[index];
    const isSaved = !provider.isNew && saved.has(provider.id);
    ask(
      customProviderName(t, provider),
      t(isSaved ? 'mu.providers.removeSaved' : 'mu.providers.removeUnsaved'),
      clearsDefault(provider.id),
      () => {
        const { [provider.id]: _dropped, ...others } = draft.providerKeys;
        onKeys(others);
        if (isSaved) markRemoved(provider.id);
        onModels({ providers: providers.filter((_, i) => i !== index), ...withoutDefault(provider.id) });
        setSelection(providers.length > 1 ? { kind: 'custom', index: Math.max(0, index - 1) } : firstAccount);
      }
    );
  };
  const removeForeign = (id: string) => {
    const entry = foreign.find((candidate) => candidate.id === id);
    ask(entry?.name || id, t('mu.providers.removeEntry'), clearsDefault(id), () => {
      markRemoved(id);
      onModels({ foreign: foreign.filter((candidate) => candidate.id !== id), ...withoutDefault(id) });
      setSelection(firstAccount);
    });
  };

  const customDot = (provider: ProviderSettings, index: number): [DotState, string] => {
    if (provider.isNew) return ['attention', t('mu.providers.unsaved')];
    const problems = providerProblems(provider, false, takenFor(index));
    const noKey = provider.key === 'managed' && !provider.keySet && !draft.providerKeys[provider.id];
    if (Object.keys(problems).length || noKey || !provider.models.length)
      return ['attention', t('mu.providers.needsSetup')];
    return ['ready', t('mu.providers.usable')];
  };
  const accountDot = (provider: SubscriptionProvider): [DotState, string] => {
    if (flow.running && flow.login?.provider === provider) return ['busy', t('mu.welcome.login.inProgress')];
    if (flow.account(provider)) return ['ready', t('mu.welcome.login.signedIn')];
    return byKey(provider) ? ['ready', t('mu.accounts.byKey')] : ['off', t('mu.accounts.signedOut')];
  };

  const item = (
    key: string,
    active: boolean,
    select: () => void,
    mark: React.ReactNode,
    name: string,
    end: React.ReactNode
  ) => (
    <div
      key={key}
      role='option'
      aria-selected={active}
      tabIndex={0}
      data-testid={`mu-provider-item-${key}`}
      className={classNames(styles.item, active && styles.itemActive)}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        select();
      }}
    >
      <span className={styles.itemMark}>{mark}</span>
      <span className={styles.itemName}>{name}</span>
      {end}
    </div>
  );

  let detail: React.ReactNode = <div className={classNames(styles.editor, styles.hint)}>{t('mu.providers.pick')}</div>;
  if (current?.kind === 'account') {
    const provider = current.provider;
    detail = (
      <AccountDetail
        provider={provider}
        flow={flow}
        byKey={byKey(provider)}
        onShow={(running) => setSelection({ kind: 'account', provider: running })}
      />
    );
  } else if (current?.kind === 'custom') {
    const { index } = current;
    const provider = providers[index];
    // A provider being added is not the saved one that happens to have the id typed so far.
    const before = provider.isNew ? undefined : saved.get(provider.id);
    detail = (
      <ProviderEditor
        // A different provider is a different form: the id-follows-name state must not carry over.
        key={before ? provider.id : `new-${index}`}
        provider={provider}
        isNew={!before}
        modified={Boolean(before) && comparable(before as ProviderSettings) !== comparable(provider)}
        takenIds={takenFor(index)}
        typedKey={draft.providerKeys[provider.id] ?? ''}
        readOnly={readOnly}
        onChange={(next) => replace(index, next)}
        onKey={(value) => onKeys({ ...draft.providerKeys, [provider.id]: value })}
        onRemove={() => removeCustom(index)}
      />
    );
  } else if (current?.kind === 'foreign') {
    const entry = foreign.find((candidate) => candidate.id === current.id);
    detail = (
      <div className={styles.editor} data-testid='mu-provider-foreign'>
        <ProviderHead
          mark={<EndpointMark size={20} />}
          title={entry?.name || current.id}
          badges={<Tag size='small'>{t('mu.providers.manual')}</Tag>}
          actions={
            <RemoveMenu disabled={readOnly} onRemove={() => removeForeign(current.id)} testId='mu-provider-more' />
          }
        />
        <div className={styles.fields}>
          <div className={styles.hint}>{t('mu.providers.foreignHelp')}</div>
          <div className={styles.hint}>
            {/* Separate facts side by side, not a sentence: an API format mu knows by its name, one it does not
                as models.json spells it. The count is written the app language's way by its text. */}
            {[
              entry?.api && (ENDPOINT_TYPES as readonly string[]).includes(entry.api)
                ? t(`mu.endpoints.${camel(entry.api)}.short`)
                : entry?.api,
              entry?.baseUrl,
              t('mu.providers.modelCount', { count: entry?.modelCount ?? 0 }),
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      </div>
    );
  } else if (current?.kind === 'builtin') {
    const entry = builtin.find((candidate) => candidate.id === current.id);
    detail = (
      <div className={styles.editor} data-testid='mu-provider-builtin'>
        <ProviderHead
          mark={<EndpointMark size={20} />}
          title={providerDisplayName(t, current.id)}
          badges={<Tag size='small'>{t('mu.providers.usable')}</Tag>}
        />
        <div className={styles.fields}>
          <div className={styles.hint}>{t('mu.providers.builtinHelp')}</div>
          <div className={styles.suggestions}>
            {entry?.models.map((model) => (
              <Tag key={model.id} size='small'>
                {model.id}
              </Tag>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const is = (kind: Selection['kind'], id: string | number) =>
    current?.kind === kind &&
    (current.kind === 'account' ? current.provider : current.kind === 'custom' ? current.index : current.id) === id;

  return (
    <div className={styles.providers}>
      {/* The page's own title names the providers: this head only says what can be done, and adds one. */}
      <div className={styles.managerHead}>
        <p className={classNames(styles.hint, 'min-w-0 m-0')}>{t('mu.providers.summary')}</p>
        <Button
          type='primary'
          size='small'
          className={styles.iconButton}
          disabled={readOnly}
          data-testid='mu-provider-add'
          icon={<Plus theme='outline' size='12' />}
          onClick={add}
        >
          {t('mu.providers.add')}
        </Button>
      </div>
      {children}
      <div className={styles.manager} data-testid='mu-provider-manager'>
        <div className={styles.list} role='listbox' aria-label={t('mu.providers.title')}>
          {flow.offered.length ? <div className={styles.listTitle}>{t('mu.providers.subscriptions')}</div> : null}
          {flow.offered.map((provider) => {
            const [state, label] = accountDot(provider);
            return item(
              `account-${provider}`,
              is('account', provider),
              () => setSelection({ kind: 'account', provider }),
              <ProviderMark provider={provider} size={18} />,
              providerName(t, provider),
              <StatusDot state={state} label={label} />
            );
          })}
          <div className={styles.listTitle}>{t('mu.providers.custom')}</div>
          {providers.map((provider, index) => {
            const [state, label] = customDot(provider, index);
            return item(
              `custom-${index}`,
              is('custom', index),
              () => setSelection({ kind: 'custom', index }),
              <EndpointMark />,
              customProviderName(t, provider),
              <StatusDot state={state} label={label} />
            );
          })}
          {!providers.length ? <div className={styles.listEmpty}>{t('mu.providers.noneYet')}</div> : null}
          {foreign.length ? <div className={styles.listTitle}>{t('mu.providers.manualGroup')}</div> : null}
          {foreign.map((entry) =>
            item(
              `foreign-${entry.id}`,
              is('foreign', entry.id),
              () => setSelection({ kind: 'foreign', id: entry.id }),
              <EndpointMark />,
              entry.name || entry.id,
              <span className={styles.itemNote}>{t('mu.providers.manualShort')}</span>
            )
          )}
          {builtin.length ? <div className={styles.listTitle}>{t('mu.providers.builtinGroup')}</div> : null}
          {builtin.map((entry) =>
            item(
              `builtin-${entry.id}`,
              is('builtin', entry.id),
              () => setSelection({ kind: 'builtin', id: entry.id }),
              <EndpointMark />,
              providerDisplayName(t, entry.id),
              <StatusDot state='ready' label={t('mu.providers.usable')} />
            )
          )}
        </div>
        {detail}
      </div>
      {modalHolder}
    </div>
  );
}
