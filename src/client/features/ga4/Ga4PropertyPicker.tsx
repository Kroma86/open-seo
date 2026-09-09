import { SearchableSelect } from "@/client/components/SearchableSelect";
import { GoogleGlyph } from "@/client/features/gsc/GoogleGlyph";
import { startGoogleLink } from "@/client/features/integrations/startGoogleLink";

type PropertyOption = {
  propertyId: string;
  displayName: string;
  accountDisplayName: string;
  isSelected: boolean;
};

type AccountOption = {
  accountId: string;
  email: string | null;
  requiresReconnect: boolean;
  propertiesUnavailable: boolean;
  properties: PropertyOption[];
};

export type Ga4PropertySelection = {
  accountId: string;
  propertyId: string;
};

type SecondaryAction = {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

export function Ga4PropertyPicker({
  loading,
  error,
  accounts,
  selection,
  onSelect,
  onSave,
  saving,
  onRetry,
  secondaryAction,
}: {
  loading: boolean;
  error: boolean;
  accounts: AccountOption[];
  selection: Ga4PropertySelection | null;
  onSelect: (selection: Ga4PropertySelection) => void;
  onSave: () => void;
  saving: boolean;
  onRetry: () => void;
  secondaryAction?: SecondaryAction;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-base-content/50">
        <span className="loading loading-spinner loading-sm" />
        Loading properties…
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-error">
          Couldn&rsquo;t load your Google Analytics properties.
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onRetry}
          >
            Try again
          </button>
          {secondaryAction ? (
            <SecondaryActionButton action={secondaryAction} />
          ) : null}
        </div>
      </div>
    );
  }

  const allAccountsRequireReconnect =
    accounts.length > 0 &&
    accounts.every((account) => account.requiresReconnect);
  if (allAccountsRequireReconnect) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-error">
          Connection expired. Reconnect to continue.
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <GoogleConnectButton
            label="Reconnect with Google"
            onClick={() => void startGoogleLink("ga4", window.location.href)}
          />
          {secondaryAction ? (
            <SecondaryActionButton action={secondaryAction} />
          ) : null}
        </div>
      </div>
    );
  }

  const usableAccounts = accounts.filter(
    (account) => !account.requiresReconnect && !account.propertiesUnavailable,
  );
  // The selection rides along on the option so picking one is a lookup rather
  // than parsing the composite value back apart.
  const options = usableAccounts.flatMap((account) =>
    account.properties.map((property) => ({
      value: `${account.accountId}:${property.propertyId}`,
      label: `${property.accountDisplayName} · ${property.displayName}`,
      hint: property.propertyId,
      group: account.email ?? "Google account",
      selection: {
        accountId: account.accountId,
        propertyId: property.propertyId,
      },
    })),
  );
  const selectedValue = selection
    ? `${selection.accountId}:${selection.propertyId}`
    : null;
  const hasSelection = options.some((option) => option.value === selectedValue);
  const hasUnavailableAccounts = accounts.some(
    (account) => account.propertiesUnavailable,
  );

  return (
    <div className="space-y-4">
      {hasUnavailableAccounts ? (
        <p className="text-sm text-warning">
          Some properties couldn&rsquo;t be loaded. Check that the Analytics
          Admin API is enabled and that this Google account has property access.
        </p>
      ) : null}
      {options.length > 0 ? (
        <div>
          <span className="mb-1.5 block text-sm font-medium text-base-content/80">
            Property
          </span>
          <SearchableSelect
            className="w-full max-w-md"
            aria-label="Google Analytics property"
            value={selectedValue}
            onChange={(value) => {
              const option = options.find((entry) => entry.value === value);
              if (option) onSelect(option.selection);
            }}
            options={options}
            placeholder="Select a property…"
            searchPlaceholder="Search by name, account, or ID"
            emptyLabel="No properties match"
          />
        </div>
      ) : null}
      {options.length === 0 && !hasUnavailableAccounts ? (
        <p className="text-sm text-base-content/60">
          No Google Analytics properties are available for this account.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onSave}
          disabled={!hasSelection || saving}
        >
          {saving ? "Saving…" : "Save property"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void startGoogleLink("ga4", window.location.href)}
        >
          Connect another Google account
        </button>
        {secondaryAction ? (
          <SecondaryActionButton action={secondaryAction} />
        ) : null}
      </div>
    </div>
  );
}

function SecondaryActionButton({ action }: { action: SecondaryAction }) {
  return (
    <button
      type="button"
      className={[
        "btn btn-ghost btn-sm",
        action.destructive ? "text-error hover:bg-error/10" : "",
      ].join(" ")}
      onClick={action.onClick}
      disabled={action.disabled}
    >
      {action.label}
    </button>
  );
}

function GoogleConnectButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2.5 rounded-lg border border-base-300 bg-base-100 px-4 py-2.5 text-sm font-semibold shadow-sm transition hover:bg-base-200"
    >
      <GoogleGlyph className="size-[18px]" />
      {label}
    </button>
  );
}
