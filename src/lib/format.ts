export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]![0], parts[parts.length - 1]![0]] : [parts[0]?.[0], parts[0]?.[1]];
  return letters.filter(Boolean).join("").toUpperCase() || "?";
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** Percentage change, rounded to an integer; null when there is no baseline. */
export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

const WALLET_LABELS: Record<string, string> = { apple_pay: "Apple Pay", google_pay: "Google Pay" };

/** "Apple Pay •••• 2084", "Visa •••• 4242" — the label the Penalty and Settings screens show. */
export function paymentMethodLabel(method: { wallet: string | null; brand: string; last4: string }): string {
  const brand = method.wallet ? (WALLET_LABELS[method.wallet] ?? method.wallet) : capitalize(method.brand);
  return `${brand} •••• ${method.last4}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
