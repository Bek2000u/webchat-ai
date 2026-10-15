import { Check, Copy, KeyRound, Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { createApiKey, deleteApiKey, setApiKeyEnabled } from "../api/app.js";
import { useAppDataContext } from "../AppContext.js";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Switch } from "../components/ui/switch.js";
import { type ApiKeyRecord } from "../../shared/contracts.js";

function timeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ru-RU");
}

export function ApiKeysPage() {
  const { apiKeys, reloadApiKeys } = useAppDataContext();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState("");
  const [revealed, setRevealed] = useState<{ label: string; secret: string } | null>(null);

  async function generate(event: FormEvent) {
    event.preventDefault();
    setBusy("create");
    try {
      const created = await createApiKey(label);
      setRevealed({ label: created.key.label, secret: created.secret });
      setLabel("");
      await reloadApiKeys();
      toast.success("API-ключ создан");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Не удалось создать API-ключ");
    } finally {
      setBusy("");
    }
  }

  async function toggle(key: ApiKeyRecord, enabled: boolean) {
    setBusy(key.id);
    try {
      await setApiKeyEnabled(key.id, enabled);
      await reloadApiKeys();
      toast.success(enabled ? "API-ключ включён" : "API-ключ выключен");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Не удалось изменить API-ключ");
    } finally {
      setBusy("");
    }
  }

  async function remove(key: ApiKeyRecord) {
    if (!window.confirm(`Удалить API-ключ «${key.label}»? Это действие нельзя отменить.`)) return;
    setBusy(key.id);
    try {
      await deleteApiKey(key.id);
      await reloadApiKeys();
      toast.success("API-ключ удалён");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Не удалось удалить API-ключ");
    } finally {
      setBusy("");
    }
  }

  async function copySecret() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.secret);
      toast.success("Ключ скопирован");
    } catch {
      toast.error("Не удалось скопировать ключ");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {revealed ? (
        <Alert className="border-primary/40 bg-primary/5">
          <KeyRound />
          <AlertTitle>Сохраните ключ «{revealed.label}» сейчас</AlertTitle>
          <AlertDescription className="mt-2 flex flex-col gap-3">
            <p>Секрет показывается только один раз. После закрытия его нельзя восстановить — только создать новый.</p>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-background px-3 py-2 text-xs text-foreground">
                {revealed.secret}
              </code>
              <Button type="button" variant="outline" onClick={() => void copySecret()}>
                <Copy />Копировать
              </Button>
              <Button type="button" variant="ghost" onClick={() => setRevealed(null)}>
                <X />Скрыть
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Новый клиентский API-ключ</CardTitle>
          <CardDescription>
            Создавайте отдельный ключ для каждого клиента или компьютера. Все ключи начинаются с <code>api_live_</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(event) => void generate(event)}>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="api-key-label">Название клиента</Label>
              <Input
                id="api-key-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Например: Ноутбук Bek или n8n production"
                maxLength={80}
                required
              />
            </div>
            <Button type="submit" disabled={busy === "create" || !label.trim()}>
              <Plus />Создать ключ
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ключи клиентов</CardTitle>
          <CardDescription>
            Секреты хранятся только как SHA-256 хеши. Утёкший ключ удалите и создайте заново.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {apiKeys.length === 0 ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              API-ключей пока нет. Создайте первый ключ выше.
            </p>
          ) : apiKeys.map((key) => (
            <div key={key.id} className="grid gap-3 rounded-lg border p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{key.label}</span>
                  <Badge variant={key.enabled ? "default" : "secondary"}>{key.enabled ? "Активен" : "Выключен"}</Badge>
                  {key.source === "environment" ? <Badge variant="outline">ENV bootstrap</Badge> : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {key.source === "environment" ? "Управляется через BOOTSTRAP_API_KEY" : `Создан ${timeLabel(key.created_at)}`}
                  {key.source === "ui" ? ` · ${key.id}` : ""}
                </p>
              </div>
              {key.mutable ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{key.enabled ? "Включён" : "Выключен"}</span>
                  <Switch
                    checked={key.enabled}
                    disabled={busy === key.id}
                    onCheckedChange={(enabled) => void toggle(key, enabled)}
                    aria-label={`Включить ключ ${key.label}`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy === key.id}
                    onClick={() => void remove(key)}
                    aria-label={`Удалить ключ ${key.label}`}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ) : (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Check className="size-3.5" />Только через ENV</span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
