import { appToken } from './credentials.mjs';
import { config } from './config.mjs';
import { searchAsUser } from './search.mjs';

const SYSTEM = `You answer questions using ONLY the numbered sources provided, which come from SharePoint documents the signed-in user is allowed to read.
Cite sources inline like [1] or [2]. If the sources don't contain the answer, say so plainly, and mention that the user may not have access to relevant documents.
Never invent sources or facts. Keep answers concise (under 180 words).`;

// Grounded answer. Retrieval runs with the user's token, so the model can only
// ever see chunks that Azure AI Search has already ACL-trimmed for this user.
export async function chat(userToken, messages) {
  const question = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const retrieval = await searchAsUser(userToken, { q: question, mode: 'hybrid', top: 6 });

  const sources = retrieval.results.map((r, i) => ({ n: i + 1, title: r.title, url: r.url, site: r.site, path: r.path, text: r.chunk }));
  const context = sources.length
    ? sources.map((s) => `[${s.n}] ${s.title} (${s.path})\n${s.text.slice(0, 1800)}`).join('\n\n')
    : '(no sources: the user has no access to any matching document)';

  const body = {
    messages: [
      { role: 'system', content: SYSTEM },
      ...messages.slice(-6, -1).map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
      { role: 'user', content: `Question: ${question}\n\nSources:\n${context}` },
    ],
    temperature: 0.2,
    max_tokens: 600,
  };
  const url = `${config.openAiEndpoint.replace(/\/$/, '')}/openai/deployments/${config.chatDeployment}/chat/completions?api-version=2024-10-21`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await appToken('https://cognitiveservices.azure.com/.default')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? `OpenAI ${res.status}`);
  return {
    answer: data.choices?.[0]?.message?.content ?? '',
    sources: sources.map(({ text, ...s }) => ({ ...s, excerpt: text.slice(0, 300) })),
    retrieved: retrieval.count,
  };
}
