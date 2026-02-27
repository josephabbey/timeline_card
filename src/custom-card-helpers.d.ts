declare module "custom-card-helpers" {
    export function formatTime(date: Date, locale?: HassLocale): string;

    interface HassLocale {
        language?: string;
        time_format?: string;
        [key: string]: unknown;
    }
}
