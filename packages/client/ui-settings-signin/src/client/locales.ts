/** Copy dictionaries for the Models-page sign-in controls. */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  signIn: 'Sign in',
  signInWith: 'Sign in with {method}',
  signOut: 'Sign out',
  signedIn: 'Signed in',
  signedInWithSubscription: 'Signed in with a provider subscription',
  signInBusy: 'A sign-in is already running for this provider.',
  signInHint: 'This provider uses a subscription sign-in instead of an API key.',
  dialogTitle: 'Sign in to {provider}',
  close: 'Close',
  cancel: 'Cancel',
  submit: 'Continue',
  submitting: 'Continuing…',
  decline: 'Not now',
  openPage: 'Open this page',
  copyCode: 'Copy code',
  copiedCode: 'Code copied',
  waiting: 'Waiting for the provider…',
  authorized: 'Signed in.',
  cancelledOutcome: 'Sign-in cancelled.',
  failedOutcome: 'Sign-in failed: {message}',
  answerRefused: 'That answer was no longer expected. Start the sign-in again.',
  signOutFailed: 'Sign-out failed: {message}',
  chooseMethod: 'Choose a sign-in method',
  secretInput: 'Value',
  textInput: 'Answer',
}

/** The settings.signin namespace key union. */
export type SignInKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: Record<SignInKey, string> = {
  signIn: '登录',
  signInWith: '使用{method}登录',
  signOut: '退出登录',
  signedIn: '已登录',
  signedInWithSubscription: '已通过提供方订阅登录',
  signInBusy: '该提供方已有一个登录流程正在进行。',
  signInHint: '该提供方使用订阅登录，而不是 API 密钥。',
  dialogTitle: '登录 {provider}',
  close: '关闭',
  cancel: '取消',
  submit: '继续',
  submitting: '正在继续…',
  decline: '暂不',
  openPage: '打开该页面',
  copyCode: '复制验证码',
  copiedCode: '验证码已复制',
  waiting: '正在等待提供方…',
  authorized: '已登录。',
  cancelledOutcome: '登录已取消。',
  failedOutcome: '登录失败：{message}',
  answerRefused: '该回答已不再被等待，请重新发起登录。',
  signOutFailed: '退出登录失败：{message}',
  chooseMethod: '选择登录方式',
  secretInput: '值',
  textInput: '回答',
}
