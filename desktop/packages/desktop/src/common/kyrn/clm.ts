/**
 * CLM-8B (github.com/Contrastive-LM/CLM) served by `clm-serve`: a judge that answers the same questions as Jev,
 * TypeSafe's hosted judge model, over the same System One protocol. The harness calls it (the `clm` judge type of kyrn-judge's registry); the app keeps
 * its address and key, and asks the server how it is.
 */

/** Where `clm-serve` listens unless told otherwise. */
export const CLM_DEFAULT_ADDRESS = 'http://127.0.0.1:8700';
/** The model a CLM judge asks for when its profile names none. */
export const CLM_DEFAULT_MODEL = 'clm-latest';
/** Where a CLM judge's key is kept when its profile names none. Only a server started with CLM_API_KEY needs one. */
export const CLM_KEY_VARIABLE = 'MU_JUDGE_CLM_API_KEY';

/**
 * The server behind a CLM judge's address, which the harness reads the same way (clmEndpoint in kyrn-judge's
 * providers/typesafe.ts): `http://host:8700`, `http://host:8700/v1` and `http://host:8700/v1/systemone` are one server.
 */
export function clmServer(baseUrl: string): string {
  return (baseUrl || CLM_DEFAULT_ADDRESS).replace(/\/+$/, '').replace(/\/v1(?:\/systemone)?$/, '');
}

/** What a CLM server says about itself, asked by the main process (process/agent/kyrn/clmServer.ts). */
export type ClmServerState =
  | { status: 'down' }
  | {
      /** `encoderDown`: the server answers, its embedding server does not, and every question fails until it does. */
      status: 'ready' | 'encoderDown';
      models: string[];
      /** It runs CLM's mock encoder (tools/playground_mock.py): its answers are noise, not CLM's. */
      mock: boolean;
      /** It was started with CLM_API_KEY, and turns away questions without the key. */
      keyRequired: boolean;
      latencyMs: number;
    };
