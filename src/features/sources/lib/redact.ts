/**
 * Display-only redaction for URLs that may carry credentials, chiefly the
 * Xtream XMLTV link `{server}/xmltv.php?username=u&password=p` that the core
 * adds to `source.epg.detectedUrls`. The stored URL is never changed: keys,
 * RPC args and toggles keep the real value; only what is rendered goes
 * through these helpers.
 */

export const REDACTED = '***';

/** Query/fragment parameter names whose values are secrets (an Xtream username is half the login). */
const SECRET_PARAMS = ['username', 'password', 'pass', 'passwd', 'pwd', 'token', 'apikey', 'api_key', 'key', 'secret', 'auth'];

const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)/i;
const PARAM = new RegExp(`([?&;#](?:${SECRET_PARAMS.join('|')})=)([^&;#]*)`, 'gi');
/** Xtream stream paths: `/live/<user>/<pass>/<id>.ts`, also movie, series and timeshift. */
const XTREAM_PATH = /\/(live|movie|series|timeshift)\/[^/?#]+\/[^/?#]+\//i;
/** Xtream short live form: `http://host:port/<user>/<pass>/<id>.ts` (exactly three path segments). */
const XTREAM_SHORT = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)\/[^/?#]+\/[^/?#]+\/(\d+\.(?:ts|m3u8))(?=$|[?#])/i;
/** URL-looking runs inside free text (error messages, test results). */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

/**
 * `http://u:p@h/x.php?username=a&password=b` -> `http://***@h/x.php?username=***&password=***`.
 * Everything in the userinfo goes (a username there is usually half the
 * secret); `password`-style query parameters keep their name and lose their
 * value. Strings that are not URLs come back unchanged.
 */
export function redactUrl(url: string): string {
  if (!url) return url;
  // The userinfo match is greedy up to the last `@` before the path, as URL parsers do.
  return url
    .replace(USERINFO, (_m, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(PARAM, (_m, name: string, value: string) => (value ? `${name}${REDACTED}` : name))
    .replace(XTREAM_PATH, (_m, kind: string) => `/${kind}/${REDACTED}/${REDACTED}/`)
    .replace(XTREAM_SHORT, (_m, origin: string, file: string) => `${origin}/${REDACTED}/${REDACTED}/${file}`);
}

/** Redacts every URL inside a free-form message. */
export function redactText(text: string | undefined | null): string {
  if (!text) return text ?? '';
  return text.replace(URL_IN_TEXT, (u) => redactUrl(u));
}
