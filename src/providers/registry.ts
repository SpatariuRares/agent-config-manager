// Every agent this app manages, in switcher order. Adding an agent is one line here.
import { claudeProvider } from './claude/index.ts'
import { codexProvider } from './codex/index.ts'
import { copilotProvider } from './copilot/index.ts'
import { geminiProvider } from './gemini/index.ts'
import { assertUniqueIds, lookupProvider, type ProviderLookup } from './router.ts'
import type { AgentProvider } from './types.ts'

export const PROVIDERS: readonly AgentProvider[] = Object.freeze([
  claudeProvider(),
  codexProvider(),
  geminiProvider(),
  copilotProvider()
])

assertUniqueIds(PROVIDERS)

/** The registered provider with this id; an unknown or missing id is refused with reason 'unknown-agent'. */
export const getProvider = (id: unknown): ProviderLookup => lookupProvider(PROVIDERS, id)
