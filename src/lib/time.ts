export function nowIso(input?: string | Date): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof Date) {
    return input.toISOString();
  }

  return new Date().toISOString();
}

export function addMinutes(timestamp: string, minutes: number): string {
  return new Date(new Date(timestamp).getTime() + minutes * 60_000).toISOString();
}

export function addHours(timestamp: string, hours: number): string {
  return addMinutes(timestamp, hours * 60);
}

export function addDays(timestamp: string, days: number): string {
  return new Date(new Date(timestamp).getTime() + days * 86_400_000).toISOString();
}

export function startOfUtcDay(timestamp: string): string {
  const date = new Date(timestamp);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}
