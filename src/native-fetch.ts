// grammY 默认用 node-fetch，不认 HTTPS_PROXY；改用 Node 原生 fetch，并把 grammY 自带的取消信号转成原生信号
export const nativeFetch = ((url: string, init?: RequestInit) => {
  const { signal, ...rest } = init ?? {};
  const ac = new AbortController();
  if (signal?.aborted) ac.abort();
  else signal?.addEventListener("abort", () => ac.abort(), { once: true });
  return fetch(url, { ...rest, signal: ac.signal });
}) as typeof fetch;
