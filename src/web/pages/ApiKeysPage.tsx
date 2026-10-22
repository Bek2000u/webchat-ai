import { t, localeTag } from "../i18n.js";
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
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(localeTag());
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
      toast.success(t("API-ключ создан"));
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : t("Не удалось создать API-ключ"));
    } finally {
      setBusy("");
    }
  }

  async function toggle(key: ApiKeyRecord, enabled: boolean) {
    setBusy(key.id);
    try {
      await setApiKeyEnabled(key.id, enabled);
      await reloadApiKeys();
      toast.success(enabled ? t("API-ключ включён") : t("API-ключ выключен"));
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : t("Не удалось изменить API-ключ"));
    } finally {
      setBusy("");
    }
  }

  async function remove(key: ApiKeyRecord) {
    if (!window.confirm(t("Удалить API-ключ «{{v0}}»? Это действие нельзя отменить.", {v0: key.label}))) return;
    setBusy(key.id);
    try {
      await deleteApiKey(key.id);
      await reloadApiKeys();
      toast.success(t("API-ключ удалён"));
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : t("Не удалось удалить API-ключ"));
    } finally {
      setBusy("");
    }
  }

  async function copySecret() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.secret);
      toast.success(t("Ключ скопирован"));
    } catch {
      toast.error(t("Не удалось скопировать ключ"));
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {revealed ? (
        <Alert className="border-primary/40 bg-primary/5">
          <KeyRound />
          <AlertTitle>{t("Сохраните ключ «")}{revealed.label}{t("» сейчас")}</AlertTitle>
          <AlertDescription className="mt-2 flex flex-col gap-3">
            <p>{t("Секрет показывается только один раз. После закрытия его нельзя восстановить — только создать новый.")}</p>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-background px-3 py-2 text-xs text-foreground">
                {revealed.secret}
              </code>
              <Button type="button" variant="outline" onClick={() => void copySecret()}>
                <Copy />{t("Копировать")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setRevealed(null)}>
                <X />{t("Скрыть")}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("Новый клиентский API-ключ")}</CardTitle>
          <CardDescription>
            {t("Создавайте отдельный ключ для каждого клиента или компьютера. Все ключи начинаются с")} <code>api_live_</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(event) => void generate(event)}>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="api-key-label">{t("Название клиента")}</Label>
              <Input
                id="api-key-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t("Например: Рабочий ноутбук или n8n production")}
                maxLength={80}
                required
              />
            </div>
            <Button type="submit" disabled={busy === "create" || !label.trim()}>
              <Plus />{t("Создать ключ")}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Ключи клиентов")}</CardTitle>
          <CardDescription>
            {t("Секреты хранятся только как SHA-256 хеши. Утёкший ключ удалите и создайте заново.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {apiKeys.length === 0 ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              {t("API-ключей пока нет. Создайте первый ключ выше.")}
            </p>
          ) : apiKeys.map((key) => (
            <div key={key.id} className="grid gap-3 rounded-lg border p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{key.label}</span>
                  <Badge variant={key.enabled ? "default" : "secondary"}>{key.enabled ? t("Активен") : t("Выключен")}</Badge>
                  {key.source === "environment" ? <Badge variant="outline">ENV bootstrap</Badge> : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {key.source === "environment" ? t("Управляется через BOOTSTRAP_API_KEY") : t("Создан {{v0}}", {v0: timeLabel(key.created_at)})}
                  {key.source === "ui" ? ` · ${key.id}` : ""}
                </p>
              </div>
              {key.mutable ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{key.enabled ? t("Включён") : t("Выключен")}</span>
                  <Switch
                    checked={key.enabled}
                    disabled={busy === key.id}
                    onCheckedChange={(enabled) => void toggle(key, enabled)}
                    aria-label={t("Включить ключ {{v0}}", {v0: key.label})}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy === key.id}
                    onClick={() => void remove(key)}
                    aria-label={t("Удалить ключ {{v0}}", {v0: key.label})}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ) : (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Check className="size-3.5" />{t("Только через ENV")}</span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
