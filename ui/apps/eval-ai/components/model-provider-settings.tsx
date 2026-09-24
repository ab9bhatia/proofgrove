"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, Cloud, HardDrive, RefreshCw } from "lucide-react";
import { Button } from "@evalai/shared/ui/button";
import { evaluationApi, type ModelProviderId, type ModelProvidersStatus, type ModelProviderStatus } from "@/lib/api";
import { modelSelectionId } from "@/lib/model-selection";

export function ModelProviderSettings({ onChange, refreshKey = 0 }: { onChange?: () => void; refreshKey?: number }) {
  const [status, setStatus] = useState<ModelProvidersStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [allowPaidCalls, setAllowPaidCalls] = useState(false);
  const [selected, setSelected] = useState<Record<ModelProviderId, string>>({ openai: "", ollama: "" });
  const requestId = useRef(0);
  const operationPending = useRef(false);
  const onChangeRef = useRef(onChange);
  const formId = useId();
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => () => { requestId.current += 1; }, []);

  const load = useCallback(async (notifyChange = false) => {
    if (operationPending.current) return;
    const token = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const next = await evaluationApi.getModelProviders();
      if (token === requestId.current) {
        setStatus(next);
        if (notifyChange) {
          window.dispatchEvent(new Event("proofgrove:providers-changed"));
          onChangeRef.current?.();
        }
      }
    } catch {
      if (token === requestId.current) setError("Provider status could not be loaded. Refresh to try again.");
    } finally {
      if (token === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, refreshKey]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operationPending.current) return;
    const submittedKey = apiKey.trim();
    // Never retain a submitted credential in the form, URL or browser storage.
    setApiKey("");
    setError(null);
    setNotice(null);
    if (!submittedKey) { setError("Enter an OpenAI API key."); return; }
    if (!allowPaidCalls) { setError("Confirm that OpenAI evaluation calls may incur charges before connecting."); return; }
    operationPending.current = true;
    const token = ++requestId.current;
    setBusy("connect");
    try {
      const next = await evaluationApi.connectOpenAI({ api_key: submittedKey, allow_paid_calls: true });
      if (token !== requestId.current) return;
      setStatus(next);
      setAllowPaidCalls(false);
      setNotice("OpenAI connection saved on the backend. Choose a model to use for new evaluations.");
      window.dispatchEvent(new Event("proofgrove:providers-changed"));
      onChangeRef.current?.();
    } catch {
      // Do not echo provider error bodies: a credential must never enter visible messages.
      if (token === requestId.current) setError("OpenAI connection could not be verified. Check the API key and account access, then enter the key again.");
    } finally {
      operationPending.current = false;
      if (token === requestId.current) { setBusy(null); setLoading(false); }
    }
  }

  async function disconnect() {
    if (operationPending.current) return;
    operationPending.current = true;
    const token = ++requestId.current;
    setApiKey(""); setBusy("disconnect"); setError(null); setNotice(null);
    try {
      const next = await evaluationApi.disconnectOpenAI();
      if (token !== requestId.current) return;
      setStatus(next);
      setNotice("OpenAI disconnected. Choose a connected provider for new evaluations.");
      window.dispatchEvent(new Event("proofgrove:providers-changed"));
      onChangeRef.current?.();
    } catch {
      if (token === requestId.current) setError("OpenAI could not be disconnected. Try again.");
    } finally {
      operationPending.current = false;
      if (token === requestId.current) { setBusy(null); setLoading(false); }
    }
  }

  function choice(provider: ModelProviderStatus) {
    return provider.models.find((model) => modelSelectionId(model) === selected[provider.id])
      ?? provider.models.find((model) => status?.default?.provider === provider.id && status.default.model_id === model.model_id && status.default.endpoint === model.endpoint)
      ?? provider.models[0]
      ?? null;
  }

  async function makeDefault(provider: ModelProviderStatus) {
    const model = choice(provider);
    if (operationPending.current || !provider.connected || !model) return;
    operationPending.current = true;
    const token = ++requestId.current;
    setBusy(provider.id); setError(null); setNotice(null);
    try {
      const next = await evaluationApi.setDefaultModel({ provider: provider.id, model_id: model.model_id });
      if (token !== requestId.current) return;
      setStatus(next);
      setNotice(`${model.model_id} is selected for new evaluations. Saved runs keep their original configuration.`);
      window.dispatchEvent(new Event("proofgrove:providers-changed"));
      onChangeRef.current?.();
    } catch {
      if (token === requestId.current) setError("The default model could not be changed. Refresh the provider list and try again.");
    } finally {
      operationPending.current = false;
      if (token === requestId.current) { setBusy(null); setLoading(false); }
    }
  }

  function modelPicker(provider: ModelProviderStatus | undefined, name: string) {
    if (!provider?.connected || !provider.models.length) return null;
    const model = choice(provider);
    const isDefault = status?.default?.provider === provider.id && status.default.model_id === model?.model_id && status.default.endpoint === model?.endpoint;
    return <div className="mt-5 border-t pt-4">
      <label htmlFor={`${formId}-${provider.id}-model`} className="mb-2 block text-sm font-medium">{name} model</label>
      <select id={`${formId}-${provider.id}-model`} value={model ? modelSelectionId(model) : ""} disabled={Boolean(busy)} onChange={(event) => setSelected((current) => ({ ...current, [provider.id]: event.target.value }))} className="h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {provider.models.map((item) => <option key={modelSelectionId(item)} value={modelSelectionId(item)}>{item.model_id}</option>)}
      </select>
      <Button type="button" className="mt-3 min-h-11" variant={isDefault ? "outline" : "default"} disabled={Boolean(busy) || isDefault} onClick={() => void makeDefault(provider)}>{isDefault ? <><CheckCircle2 className="mr-2 size-4" aria-hidden="true" />Default model</> : busy === provider.id ? "Saving…" : "Use for new evaluations"}</Button>
    </div>;
  }

  const openai = status?.providers.find((provider) => provider.id === "openai");
  const ollama = status?.providers.find((provider) => provider.id === "ollama");
  const keyForm = <form onSubmit={(event) => void connect(event)} autoComplete="off" noValidate className="mt-4 space-y-3">
    <div>
      <label htmlFor={`${formId}-key`} className="mb-2 block text-sm font-medium">OpenAI API key</label>
      <input id={`${formId}-key`} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" spellCheck={false} disabled={Boolean(busy)} aria-describedby={`${formId}-key-note`} className="h-11 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      <p id={`${formId}-key-note`} className="mt-2 text-xs leading-5 text-muted-foreground">Stored only on this app’s backend. The field clears when submitted. Connecting lists accessible models; it does not generate an answer.</p>
    </div>
    <label className="flex min-h-11 cursor-pointer items-start gap-2 py-2 text-xs leading-5"><input type="checkbox" checked={allowPaidCalls} onChange={(event) => setAllowPaidCalls(event.target.checked)} disabled={Boolean(busy)} className="mt-1" />I understand OpenAI evaluation calls may incur charges.</label>
    <Button type="submit" className="min-h-11" disabled={Boolean(busy)}>{busy === "connect" ? "Verifying connection…" : openai?.connected ? "Update OpenAI connection" : "Connect OpenAI"}</Button>
  </form>;

  return <section aria-labelledby={`${formId}-heading`} className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id={`${formId}-heading`} className="text-lg font-semibold">Connect a model provider</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Use OpenAI with your API key or a model installed locally through Ollama.</p></div>
      <Button type="button" variant="outline" size="sm" disabled={loading || Boolean(busy)} onClick={() => void load(true)}><RefreshCw className={`mr-2 size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />{loading ? "Checking…" : "Refresh providers"}</Button>
    </div>
    {error ? <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</p> : null}
    {notice ? <p role="status" className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">{notice}</p> : null}
    <div className="grid gap-4 lg:grid-cols-2">
      <article className="rounded-xl border bg-card p-5">
        <div className="flex items-start justify-between gap-3"><div className="flex items-center gap-2"><Cloud className="size-5 text-brand-text" aria-hidden="true" /><h3 className="font-semibold">OpenAI</h3></div><span className="rounded-full border px-2.5 py-1 text-xs">{openai ? openai.connected ? "Connected" : "Needs API key" : loading ? "Checking…" : "Status unavailable"}</span></div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">Cloud models through your OpenAI account.</p>
        {openai?.connected ? <>
          <p className="mt-2 text-xs text-muted-foreground">{openai.models.length} models discovered. A model-list check does not verify generation.</p>
          {modelPicker(openai, "OpenAI")}
          <details className="mt-4 border-t pt-3"><summary className="w-fit cursor-pointer rounded py-2 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Replace API key</summary>{keyForm}</details>
          <button type="button" onClick={() => void disconnect()} disabled={Boolean(busy)} className="mt-2 min-h-11 rounded text-xs text-muted-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{busy === "disconnect" ? "Disconnecting…" : "Disconnect OpenAI"}</button>
        </> : keyForm}
        {!openai?.connected && openai?.message ? <p className="mt-3 text-xs leading-5 text-muted-foreground">{openai.message}</p> : null}
      </article>
      <article className="rounded-xl border bg-card p-5">
        <div className="flex items-start justify-between gap-3"><div className="flex items-center gap-2"><HardDrive className="size-5 text-brand-text" aria-hidden="true" /><h3 className="font-semibold">Local Ollama</h3></div><span className="rounded-full border px-2.5 py-1 text-xs">{ollama ? ollama.connected ? "Connected" : "Unavailable" : loading ? "Checking…" : "Status unavailable"}</span></div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">Generate answers on this Mac with an installed model. No cloud API key or paid API call is needed.</p>
        {ollama?.connected ? <p className="mt-2 text-xs text-muted-foreground">{ollama.models.length} installed {ollama.models.length === 1 ? "model" : "models"} discovered.</p> : null}
        {modelPicker(ollama, "Ollama")}
        {ollama?.message ? <p className="mt-3 text-xs leading-5 text-muted-foreground">{ollama.message}</p> : null}
        {ollama && !ollama.models.length ? <p className="mt-4 text-xs leading-5 text-muted-foreground">Start Ollama and install a chat model, then refresh providers.</p> : null}
      </article>
    </div>
    <div className="rounded-lg border bg-muted/25 px-4 py-3 text-sm"><span className="font-medium">Default for new evaluations: </span>{status?.default ? <><span className="break-all">{status.default.model_id}</span><span className="text-muted-foreground"> · {status.default.provider === "ollama" ? "Local Ollama" : "OpenAI"}</span></> : <span className="text-muted-foreground">{loading ? "Checking…" : "Choose a connected model above."}</span>}</div>
  </section>;
}
