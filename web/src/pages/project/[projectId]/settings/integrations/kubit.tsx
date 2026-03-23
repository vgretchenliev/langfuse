import Header from "@/src/components/layouts/header";
import ContainerPage from "@/src/components/layouts/container-page";
import { StatusBadge } from "@/src/components/layouts/status-badge";
import { Alert, AlertDescription } from "@/src/components/ui/alert";
import { Button } from "@/src/components/ui/button";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/src/components/ui/form";
import { Input } from "@/src/components/ui/input";
import { PasswordInput } from "@/src/components/ui/password-input";
import { Switch } from "@/src/components/ui/switch";
import { Card } from "@/src/components/ui/card";
import { kubitIntegrationFormSchema } from "@/src/features/kubit-integration/types";
import { EXPORT_SOURCE_OPTIONS } from "@langfuse/shared";
import { useV4Beta } from "@/src/features/events/hooks/useV4Beta";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { api } from "@/src/utils/api";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/router";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { type z } from "zod/v4";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/src/components/ui/tooltip";
import { Info } from "lucide-react";

const DEFAULT_ENDPOINT_URL = "https://langfuse-ingest.kubit.ai";

export default function KubitIntegrationSettings() {
  const router = useRouter();
  const projectId = router.query.projectId as string;

  const hasAccess = useHasProjectAccess({
    projectId,
    scope: "integrations:CRUD",
  });

  const state = api.kubitIntegration.get.useQuery(
    { projectId },
    { enabled: hasAccess },
  );

  const status =
    state.isInitialLoading || !hasAccess
      ? undefined
      : state.data?.enabled
        ? "active"
        : "inactive";

  return (
    <ContainerPage
      headerProps={{
        title: "Kubit Integration",
        breadcrumb: [
          { name: "Settings", href: `/project/${projectId}/settings` },
        ],
        actionButtonsLeft: <>{status && <StatusBadge type={status} />}</>,
        actionButtonsRight: (
          <Button asChild variant="secondary">
            <Link href="https://langfuse.com/integrations/analytics/kubit">
              Integration Docs ↗
            </Link>
          </Button>
        ),
      }}
    >
      <p className="mb-4 text-sm text-primary">
        Integrate with{" "}
        <Link href="https://kubit.ai" className="underline">
          Kubit
        </Link>{" "}
        to sync your Langfuse traces, observations, and scores for advanced
        product analytics. Upon activation, all historical data from your
        project will be synced. After the initial sync, new data is
        automatically synced on the configured interval.
      </p>
      {!hasAccess && (
        <p className="text-sm">
          Your current role does not grant you access to these settings, please
          reach out to your project admin or owner.
        </p>
      )}
      {hasAccess && state.data?.lastError && (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <p className="font-semibold">
              Integration disabled — authentication failed
            </p>
            <p className="mt-1 text-sm">
              The API key was rejected by the Kubit token endpoint. Update the
              API key below and re-enable the integration.
            </p>
            <p className="mt-1 font-mono text-xs opacity-75">
              {state.data.lastError}
            </p>
          </AlertDescription>
        </Alert>
      )}
      {hasAccess && (
        <>
          <Header title="Configuration" />
          <Card className="p-3">
            <KubitIntegrationSettingsForm
              state={state.data}
              projectId={projectId}
              isLoading={state.isLoading}
            />
          </Card>
        </>
      )}
      {state.data?.enabled && (
        <>
          <Header title="Status" className="mt-8" />
          <p className="text-sm text-primary">
            Data synced until:{" "}
            {state.data?.lastSyncAt
              ? new Date(state.data.lastSyncAt).toLocaleString()
              : "Never (pending)"}
          </p>
        </>
      )}
    </ContainerPage>
  );
}

const KubitIntegrationSettingsForm = ({
  state,
  projectId,
  isLoading,
}: {
  state?: {
    endpointUrl: string;
    enabled: boolean;
    syncIntervalMinutes: number;
    requestTimeoutSeconds: number;
    exportSource?: string | null;
    lastSyncAt?: Date | null;
    lastError?: string | null;
  } | null;
  projectId: string;
  isLoading: boolean;
}) => {
  const { isBetaEnabled } = useV4Beta();

  const kubitForm = useForm({
    resolver: zodResolver(kubitIntegrationFormSchema),
    defaultValues: {
      endpointUrl: state?.endpointUrl ?? DEFAULT_ENDPOINT_URL,
      apiKey: "",
      enabled: state?.enabled ?? false,
      syncIntervalMinutes: state?.syncIntervalMinutes ?? 60,
      requestTimeoutSeconds: state?.requestTimeoutSeconds ?? 30,
      exportSource:
        (state?.exportSource as z.infer<
          typeof kubitIntegrationFormSchema
        >["exportSource"]) ??
        (isBetaEnabled ? "EVENTS" : "TRACES_OBSERVATIONS"),
    },
    disabled: isLoading,
  });

  useEffect(() => {
    kubitForm.reset({
      endpointUrl: state?.endpointUrl ?? DEFAULT_ENDPOINT_URL,
      apiKey: "",
      enabled: state?.enabled ?? false,
      syncIntervalMinutes: state?.syncIntervalMinutes ?? 60,
      requestTimeoutSeconds: state?.requestTimeoutSeconds ?? 30,
      exportSource:
        (state?.exportSource as z.infer<
          typeof kubitIntegrationFormSchema
        >["exportSource"]) ??
        (isBetaEnabled ? "EVENTS" : "TRACES_OBSERVATIONS"),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const utils = api.useUtils();
  const mut = api.kubitIntegration.update.useMutation({
    onSuccess: () => {
      utils.kubitIntegration.invalidate();
    },
  });
  const mutDelete = api.kubitIntegration.delete.useMutation({
    onSuccess: () => {
      utils.kubitIntegration.invalidate();
    },
  });

  async function onSubmit(values: z.infer<typeof kubitIntegrationFormSchema>) {
    mut.mutate({ projectId, ...values });
  }

  return (
    <Form {...kubitForm}>
      <form className="space-y-3" onSubmit={kubitForm.handleSubmit(onSubmit)}>
        <FormField
          control={kubitForm.control}
          name="endpointUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Endpoint URL</FormLabel>
              <FormControl>
                <Input {...field} placeholder={DEFAULT_ENDPOINT_URL} />
              </FormControl>
              <FormDescription>
                The full ingest URL of your Kubit instance
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={kubitForm.control}
          name="apiKey"
          render={({ field }) => (
            <FormItem>
              <FormLabel>API Key</FormLabel>
              <FormControl>
                <PasswordInput
                  {...field}
                  placeholder={
                    state ? "Enter to update API key" : "Enter API key"
                  }
                />
              </FormControl>
              <FormDescription>
                {state
                  ? "Leave blank to keep the existing API key"
                  : "API key generated in Kubit for this project"}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={kubitForm.control}
          name="syncIntervalMinutes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Sync Interval (minutes)</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="number"
                  min={15}
                  max={1440}
                  onChange={(e) => field.onChange(parseInt(e.target.value, 10))}
                />
              </FormControl>
              <FormDescription>
                How often data is synced to Kubit (min: 15, max: 1440)
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={kubitForm.control}
          name="requestTimeoutSeconds"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Request Timeout (seconds)</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="number"
                  min={5}
                  max={300}
                  onChange={(e) => field.onChange(parseInt(e.target.value, 10))}
                />
              </FormControl>
              <FormDescription>
                How long to wait for a response from Kubit before retrying (min:
                5, max: 300)
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        {isBetaEnabled && (
          <FormField
            control={kubitForm.control}
            name="exportSource"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="flex items-center gap-1">
                  Export Source
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3 w-3 cursor-help text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {
                        EXPORT_SOURCE_OPTIONS.find(
                          (o) => o.value === field.value,
                        )?.description
                      }
                    </TooltipContent>
                  </Tooltip>
                </FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {EXPORT_SOURCE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}
        <FormField
          control={kubitForm.control}
          name="enabled"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Enabled</FormLabel>
              <FormControl>
                <Switch
                  id="kubit-integration-enabled"
                  checked={field.value}
                  onCheckedChange={() => {
                    field.onChange(!field.value);
                  }}
                  className="ml-4 mt-1"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </form>
      <div className="mt-8 flex gap-2">
        <Button
          loading={mut.isPending}
          onClick={kubitForm.handleSubmit(onSubmit)}
          disabled={isLoading}
        >
          Save
        </Button>
        <Button
          variant="ghost"
          loading={mutDelete.isPending}
          disabled={isLoading || !!!state}
          onClick={() => {
            if (
              confirm(
                "Are you sure you want to reset the Kubit integration for this project?",
              )
            )
              mutDelete.mutate({ projectId });
          }}
        >
          Reset
        </Button>
      </div>
    </Form>
  );
};
