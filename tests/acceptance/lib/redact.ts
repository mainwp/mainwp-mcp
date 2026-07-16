export interface RedactorValues {
  username?: string;
  appPassword?: string;
  dashboardUrl?: string;
  authorization?: string;
}

interface Replacement {
  value: string;
  token: string;
}

export class Redactor {
  private readonly replacements: Replacement[] = [];

  constructor(values: RedactorValues = {}) {
    this.add(values);
  }

  add(values: RedactorValues): void {
    this.addReplacement(values.authorization, '<redacted:authorization>');
    this.addReplacement(values.appPassword, '<redacted:app-password>');
    if (values.appPassword) {
      const compact = values.appPassword.replace(/\s+/g, '');
      if (compact !== values.appPassword) {
        this.addReplacement(compact, '<redacted:app-password>');
      }
    }
    this.addReplacement(values.username, '<redacted:username>');
    if (values.dashboardUrl) {
      try {
        this.addReplacement(new URL(values.dashboardUrl).origin, '<dashboard>');
      } catch {
        this.addReplacement(values.dashboardUrl, '<dashboard>');
      }
    }
    this.replacements.sort((a, b) => b.value.length - a.value.length);
  }

  private addReplacement(value: string | undefined, token: string): void {
    if (!value || this.replacements.some(replacement => replacement.value === value)) return;
    this.replacements.push({ value, token });
  }

  redact(value: string): string {
    let redacted = value;
    for (const replacement of this.replacements) {
      redacted = redacted.split(replacement.value).join(replacement.token);
    }
    return redacted;
  }

  stringify(value: unknown, spacing?: number): string {
    return this.redact(JSON.stringify(value, null, spacing));
  }
}
