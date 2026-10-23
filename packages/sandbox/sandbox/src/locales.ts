/** Locale-owned sandbox approval text; audit inputs remain verbatim. */

/** English escalation messages. */
export const en = {
  escalation: (mode: string, justification: string): string => `Allow this operation with ${mode} permissions: ${justification}`,
}

/** Chinese escalation messages. */
export const zh = {
  escalation: (mode: string, justification: string): string => `允许本次操作使用 ${mode} 权限：${justification}`,
} satisfies typeof en

/** Japanese escalation messages. */
export const ja = {
  escalation: (mode: string, justification: string): string => `${mode} 権限でこの操作を許可します：${justification}`,
} satisfies typeof en

/** Spanish dictionary, checked against the English keys. */
export const es = {
  escalation: (mode: string, justification: string): string => `Permitir esta operación con permisos ${mode}: ${justification}`,
} satisfies typeof en

/** French dictionary, checked against the English keys. */
export const fr = {
  escalation: (mode: string, justification: string): string => `Autoriser cette opération avec les permissions ${mode} : ${justification}`,
} satisfies typeof en

/** German dictionary, checked against the English keys. */
export const de = {
  escalation: (mode: string, justification: string): string => `Diesen Vorgang mit ${mode}-Berechtigungen zulassen: ${justification}`,
} satisfies typeof en

/** Russian dictionary, checked against the English keys. */
export const ru = {
  escalation: (mode: string, justification: string): string => `Разрешить эту операцию с правами ${mode}: ${justification}`,
} satisfies typeof en

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  escalation: (mode: string, justification: string): string => `Permitir esta operação com permissões ${mode}: ${justification}`,
} satisfies typeof en

/**
 * Build translations for the existing Client localized-text resolver.
 * @param mode - requested sandbox mode.
 * @param justification - raw model justification, preserved in every translation.
 * @param note - provider sentence appended after the justification, localized per locale with an English fallback.
 * @returns localized approval text.
 */
export function escalationDisplayReason(
  mode: string,
  justification: string,
  note?: { readonly en: string; readonly [locale: string]: string },
): Record<'en' | 'zh' | 'ja' | 'es' | 'fr' | 'de' | 'ru' | 'pt', string> {
  const withNote = (locale: string, text: string): string => note === undefined ? text : `${text} ${note[locale] ?? note.en}`
  return {
    en: withNote('en', en.escalation(mode, justification)),
    zh: withNote('zh', zh.escalation(mode, justification)),
    ja: withNote('ja', ja.escalation(mode, justification)),
    es: withNote('es', es.escalation(mode, justification)),
    fr: withNote('fr', fr.escalation(mode, justification)),
    de: withNote('de', de.escalation(mode, justification)),
    ru: withNote('ru', ru.escalation(mode, justification)),
    pt: withNote('pt', pt.escalation(mode, justification)),
  }
}
