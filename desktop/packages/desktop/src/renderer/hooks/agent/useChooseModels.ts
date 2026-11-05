import { useNavigate } from 'react-router-dom';

/**
 * The account a model menu's "Choose which models appear" asked the providers page to show: kept until the page opens
 * and takes it (`takeAccountToShow`), so the page opens on that account's models instead of its first entry.
 */
let accountToShow: string | undefined;

/** Asks the providers page to open on this provider's account, the next time it opens. */
export function showAccountNext(provider: string | undefined): void {
  accountToShow = provider;
}

/** The provider a model menu asked the providers page to show, once: the page takes it when it opens. */
export function takeAccountToShow(): string | undefined {
  const asked = accountToShow;
  accountToShow = undefined;
  return asked;
}

/**
 * Opens Settings, Providers, where an account's models are checked for the model menus: on the account of `model`
 * (`provider/model-id`, the model in use) when there is one.
 */
export function useChooseModels(): (model?: string | null) => void {
  const navigate = useNavigate();
  return (model) => {
    const slash = model ? model.indexOf('/') : -1;
    showAccountNext(model && slash > 0 ? model.slice(0, slash) : undefined);
    void navigate('/settings/providers');
  };
}
