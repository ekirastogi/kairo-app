import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CURSOR_API = 'https://api.cursor.com/v1';

interface Body {
  apiKey?: string;
  prompt?: string;
  agentId?: string;
  runId?: string;
  action?: 'start' | 'poll';
}

interface CursorRun {
  id: string;
  agentId?: string;
  status: string;
  result?: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'POST required' }, 405);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const apiKey = body.apiKey?.trim();
  if (!apiKey) return json({ error: 'Cursor API key is required' }, 400);

  const action = body.action === 'poll' ? 'poll' : 'start';

  try {
    if (action === 'poll') {
      if (!body.agentId || !body.runId) {
        return json({ error: 'agentId and runId are required to poll' }, 400);
      }
      const run = await waitForRun(apiKey, body.agentId, body.runId, 20_000);
      return json(runPayload(body.agentId, run));
    }

    const prompt = body.prompt?.trim();
    if (!prompt) return json({ error: 'prompt is required' }, 400);

    let agentId = body.agentId?.trim() || '';

    if (agentId) {
      const follow = await cursorRequest(apiKey, `${CURSOR_API}/agents/${agentId}/runs`, {
        method: 'POST',
        body: JSON.stringify({ prompt: { text: prompt } }),
      });
      if (follow.ok) {
        const run = extractRun(follow.body);
        const waited = await waitForRun(apiKey, agentId, run.id, 20_000);
        return json(runPayload(agentId, waited));
      }
      if (follow.status !== 404 && follow.status !== 409) {
        return json({ error: cursorError(follow.body, follow.status) }, follow.status);
      }
      agentId = '';
    }

    const created = await cursorRequest(apiKey, `${CURSOR_API}/agents`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Kairo Ask AI',
        prompt: { text: prompt },
        model: {
          id: 'composer-2',
          params: [{ id: 'fast', value: 'true' }],
        },
      }),
    });
    if (!created.ok) {
      return json({ error: cursorError(created.body, created.status) }, created.status);
    }
    const agent = (created.body as { agent?: { id?: string } }).agent;
    const run = extractRun(created.body);
    agentId = agent?.id || run.agentId || '';
    if (!agentId) return json({ error: 'Cursor did not return an agent id' }, 502);
    const waited = await waitForRun(apiKey, agentId, run.id, 20_000);
    return json(runPayload(agentId, waited));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Cursor request failed' }, 502);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function extractRun(body: unknown): CursorRun {
  const raw = body as { run?: CursorRun; id?: string; agentId?: string; status?: string; result?: string };
  const run = raw.run ?? (raw as CursorRun);
  if (!run?.id) throw new Error('Cursor did not return a run id');
  return run;
}

function runPayload(agentId: string, run: CursorRun): Record<string, unknown> {
  const status = (run.status || '').toUpperCase();
  const done = status === 'FINISHED' || status === 'COMPLETED';
  if (done) {
    return { status: 'FINISHED', agentId, runId: run.id, text: (run.result || '').trim() };
  }
  if (status === 'ERROR' || status === 'CANCELLED' || status === 'EXPIRED') {
    return {
      status,
      agentId,
      runId: run.id,
      error: run.result || `Cursor run ${status.toLowerCase()}`,
    };
  }
  return { status: 'RUNNING', agentId, runId: run.id };
}

async function waitForRun(
  apiKey: string,
  agentId: string,
  runId: string,
  budgetMs: number
): Promise<CursorRun> {
  const start = Date.now();
  let run: CursorRun = { id: runId, agentId, status: 'RUNNING' };
  while (Date.now() - start < budgetMs) {
    const res = await cursorRequest(apiKey, `${CURSOR_API}/agents/${agentId}/runs/${runId}`, {
      method: 'GET',
    });
    if (!res.ok) throw new Error(cursorError(res.body, res.status));
    run = extractRun(res.body);
    const status = (run.status || '').toUpperCase();
    if (
      status === 'FINISHED' ||
      status === 'COMPLETED' ||
      status === 'ERROR' ||
      status === 'CANCELLED' ||
      status === 'EXPIRED'
    ) {
      return run;
    }
    await sleep(1500);
  }
  return run;
}

async function cursorRequest(
  apiKey: string,
  url: string,
  init: { method: string; body?: string }
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const headersList = [
    {
      Authorization: `Basic ${btoa(`${apiKey}:`)}`,
      'Content-Type': 'application/json',
    },
    {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  ];
  let last = { ok: false, status: 401, body: {} as unknown };
  for (const headers of headersList) {
    const res = await fetch(url, { ...init, headers });
    const body = await res.json().catch(() => ({}));
    last = { ok: res.ok, status: res.status, body };
    if (res.ok || (res.status !== 401 && res.status !== 403)) return last;
  }
  return last;
}

function cursorError(body: unknown, status: number): string {
  const err = body as { error?: { message?: string } | string; message?: string };
  if (typeof err?.error === 'string' && err.error.trim()) return err.error;
  if (typeof err?.error === 'object' && err.error?.message) return err.error.message;
  if (typeof err?.message === 'string' && err.message.trim()) return err.message;
  if (status === 401 || status === 403) return 'Cursor rejected this API key.';
  if (status === 404) {
    return 'Cursor chat needs a user API key with no-repo cloud agents enabled.';
  }
  return `Cursor request failed (${status})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
