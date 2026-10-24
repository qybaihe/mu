/**
 * Signing in to a model provider's subscription (ChatGPT, Grok, and a Google account through Gemini CLI or
 * Antigravity) with pi's own OAuth flows, from the app. A Claude subscription is no longer offered: Anthropic doesn't
 * allow other apps to sign in with one (an account signed in before can still be signed out). The main process runs the flow in a child process and opens
 * the browser; the screen polls the state and answers what a flow asks (a code to paste, a choice). No credential
 * ever comes back to the screen.
 */

/**
 * Every subscription the app knows how to sign in to, by pi's provider id, in the order they are shown. ChatGPT is
 * OpenAI's own Sign in with ChatGPT on the `openai` provider; `openai-codex` is the Codex CLI's login it replaces, shown
 * only for an account signed in with it before.
 */
export const SUBSCRIPTION_PROVIDERS = [
  'openai',
  'openai-codex',
  'anthropic',
  'xai',
  'google-gemini-cli',
  'google-antigravity',
] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

export const isSubscriptionProvider = (value: unknown): value is SubscriptionProvider =>
  SUBSCRIPTION_PROVIDERS.includes(value as SubscriptionProvider);

/**
 * The Google sign-ins borrow Google's logins for its own tools. mu's harness adds them (experimental, and only while
 * its `googleLogin` feature is on); before the browser opens, the flow asks the person to accept the risk.
 */
export const GOOGLE_PROVIDERS: readonly SubscriptionProvider[] = ['google-gemini-cli', 'google-antigravity'];
export const isGoogleProvider = (provider: SubscriptionProvider | undefined) =>
  provider !== undefined && GOOGLE_PROVIDERS.includes(provider);

/** What every harness can sign in to: pi's own flows. The rest is only offered when the runner says so. */
export const BUILT_IN_PROVIDERS: readonly SubscriptionProvider[] = ['openai', 'xai'];
/**
 * Sign-ins no longer offered: an account signed in with one is shown (and can sign out), never a new one. ChatGPT
 * through the Codex CLI's login, which Sign in with ChatGPT replaces; a Claude subscription, which Anthropic doesn't
 * allow other apps to sign in with.
 */
export const LEGACY_PROVIDERS: readonly SubscriptionProvider[] = ['openai-codex', 'anthropic'];
/**
 * Subscriptions whose provider id also takes an API key (pi reads OPENAI_API_KEY, ANTHROPIC_API_KEY and XAI_API_KEY):
 * mu can report them as usable while nobody is signed in. The others are usable only signed in.
 */
export const KEY_PROVIDERS: readonly SubscriptionProvider[] = ['openai', 'anthropic', 'xai'];
/**
 * Subscriptions named by their maker outside the sign-in screens: an OpenAI API key's models are not ChatGPT's, so
 * the model picker says OpenAI, while the sign-in says ChatGPT.
 */
export const MAKER_NAMED: readonly SubscriptionProvider[] = ['openai'];

export type LoginModel = { id: string; name: string };

/** What a flow asks the person: a code to paste (raced with the browser callback), a line of text, a choice. */
export type LoginPrompt = {
  type: 'manual_code' | 'text' | 'secret' | 'select';
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
};

export type LoginPhase = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';

export type LoginState = {
  /** Grows with every start, so a screen can tell an old answer from the current one. */
  id: number;
  provider?: SubscriptionProvider;
  phase: LoginPhase;
  /** The page the flow opened in the browser: shown so it can be opened again. */
  url?: string;
  /** For flows that show a code on one device and take it on another. */
  device?: { userCode: string; verificationUri: string };
  /** The flow's latest progress or info line. */
  message?: string;
  /** The credential is stored: the account is signed in, and what it can use is still being read. */
  stored?: boolean;
  prompt?: LoginPrompt;
  /** After success: what the account can use, from pi's catalogue. */
  models?: LoginModel[];
  error?: string;
};

/**
 * Who is signed in already, by provider, with what they can use, and what this harness can sign in to (`offered`,
 * in the order they are shown; absent when the runner did not say).
 */
export type LoginStatus = {
  signedIn: { provider: SubscriptionProvider; models: LoginModel[] }[];
  offered?: SubscriptionProvider[];
};

/** A model a sign-out switched to: pi's provider and model ids, and the model's name. */
export type SwitchedModel = { provider: string; model: string; name: string };

/**
 * What a sign-out moved off the account's models besides its credential: the model new conversations start on
 * (`defaultMoved`) and the running conversations (`conversations`, how many), each when it was one of the account's
 * models and mu no longer offers it. `to` is the model they went on with; left out when no other model is set up.
 */
export type SignOutSwitch = { defaultMoved: boolean; conversations: number; to?: SwitchedModel };

/**
 * The providers to show: what the runner offers (or pi's own ones until it has said), and any other one an account is
 * signed in to (a login no longer offered), so it can still be seen and signed out. Always in the app's order.
 */
export const offeredProviders = (status: LoginStatus): SubscriptionProvider[] =>
  SUBSCRIPTION_PROVIDERS.filter(
    (provider) =>
      (status.offered ?? BUILT_IN_PROVIDERS).includes(provider) ||
      status.signedIn.some((account) => account.provider === provider)
  );

/** The risk question of a Google sign-in: a choice to go on or not, asked before any browser or port is opened. */
export const isRiskConsent = (provider: SubscriptionProvider | undefined, prompt: LoginPrompt | undefined) =>
  isGoogleProvider(provider) &&
  prompt?.type === 'select' &&
  ['continue', 'cancel'].every((id) => prompt.options?.some((option) => option.id === id));
