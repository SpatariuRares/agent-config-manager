// Plugins as cards in a grid, grouped by marketplace: switch, contents, project overrides, uninstall.
import { Badge, Button, Card, Collapsible, EmptyState, Grid, Heading, read, Row, Select, set, Stack, Switch, Text } from 'orca'
import { effectiveState, type Plugin, type PluginContributions } from '../../core/inventory.ts'
import {
  busy,
  clearOverride,
  confirmingUninstall,
  context,
  GLOBAL,
  projectLabel,
  query,
  saveIn,
  setPlugin,
  uninstall
} from './store.ts'

const KINDS: { key: keyof PluginContributions; one: string; many: string }[] = [
  { key: 'skills', one: 'skill', many: 'skills' },
  { key: 'agents', one: 'agent', many: 'agents' },
  { key: 'commands', one: 'command', many: 'commands' },
  { key: 'hooks', one: 'hook', many: 'hooks' },
  { key: 'mcpServers', one: 'MCP server', many: 'MCP servers' }
]

const SOURCE = { user: 'global setting', project: 'team setting', local: 'my setting' }

function matches(plugin: Plugin, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (needle === '') return true
  const haystack = [plugin.id, ...Object.values(plugin.contributes).flat()].join(' ').toLowerCase()
  return haystack.includes(needle)
}

function Contents({ plugin }: { plugin: Plugin }) {
  const kinds = KINDS.filter((kind) => plugin.contributes[kind.key].length > 0)
  if (kinds.length === 0) return <Text muted size="xs">Nothing to list (LSP or settings only)</Text>
  return (
    <Stack gap="xs">
      <Row gap="xs" wrap>
        {kinds.map((kind) => {
          const count = plugin.contributes[kind.key].length
          return <Badge key={kind.key}>{`${count} ${count === 1 ? kind.one : kind.many}`}</Badge>
        })}
      </Row>
      <Collapsible title="Contents">
        <Stack gap="xs">
          {kinds.map((kind) => (
            <Text key={kind.key} size="xs">
              <Text weight="semibold" size="xs">{`${kind.many}: `}</Text>
              {plugin.contributes[kind.key].join(', ')}
            </Text>
          ))}
        </Stack>
      </Collapsible>
    </Stack>
  )
}

function Overrides({ plugin }: { plugin: Plugin }) {
  if (plugin.overrides.length === 0) return null
  const on = plugin.overrides.filter((o) => o.enabled).length
  return (
    <Collapsible title="Projects" description={`${on} on, ${plugin.overrides.length - on} off`}>
      <Stack gap="xs">
        {plugin.overrides.map((o) => (
          <Row key={`${o.project}-${o.scope}`} justify="between" align="center">
            <Text size="xs">{`${projectLabel(o.project)} · ${o.scope === 'local' ? 'me' : 'team'}: ${o.enabled ? 'on' : 'off'}`}</Text>
            <Button
              size="xs"
              variant="ghost"
              tooltip="Remove this override: the project follows the global setting"
              disabled={read(busy) !== null}
              onPress={() => clearOverride(plugin.id, o.project, o.scope)}
            >
              Clear
            </Button>
          </Row>
        ))}
      </Stack>
    </Collapsible>
  )
}

function Uninstall({ plugin }: { plugin: Plugin }) {
  if (plugin.installs.length === 0) return null
  if (read(confirmingUninstall) !== plugin.id) {
    return (
      <Row justify="end">
        <Button size="xs" variant="ghost" icon="delete" disabled={read(busy) !== null} onPress={() => set(confirmingUninstall, plugin.id)}>
          Uninstall
        </Button>
      </Row>
    )
  }
  const where = plugin.installs.map((i) => (i.project ? projectLabel(i.project) : 'user')).join(', ')
  return (
    <Stack gap="xs">
      <Text size="xs" tone="danger">{`Remove ${plugin.name} (${where})? Its data is kept.`}</Text>
      <Row gap="xs">
        <Button size="xs" tone="danger" onPress={() => uninstall(plugin.id)}>
          Uninstall
        </Button>
        <Button size="xs" variant="ghost" onPress={() => set(confirmingUninstall, null)}>
          Cancel
        </Button>
      </Row>
    </Stack>
  )
}

function PluginCard({ plugin }: { plugin: Plugin }) {
  const where = read(context)
  const state = where === GLOBAL ? { enabled: plugin.enabled, from: 'user' as const } : effectiveState(plugin, where)
  const label = where === GLOBAL ? (state.enabled ? 'Enabled' : 'Disabled') : `${state.enabled ? 'On' : 'Off'} (${SOURCE[state.from]})`
  return (
    <Card title={plugin.name} description={plugin.version ? `v${plugin.version}` : 'not installed'}>
      <Stack gap="sm">
        <Switch label={label} checked={state.enabled} disabled={read(busy) !== null} onChange={(on) => setPlugin(plugin.id, on)} />
        <Contents plugin={plugin} />
        {plugin.sharesNameWith.length > 0 && (
          <Text tone="warning" size="xs">{`Also installed from ${plugin.sharesNameWith.map((id) => id.slice(id.lastIndexOf('@') + 1)).join(', ')}`}</Text>
        )}
        <Overrides plugin={plugin} />
        <Uninstall plugin={plugin} />
      </Stack>
    </Card>
  )
}

function ContextBar({ projects }: { projects: string[] }) {
  const where = read(context)
  const options = [
    { value: GLOBAL, label: 'Everywhere (global)' },
    ...projects.map((p) => ({ value: p, label: `Project: ${projectLabel(p)}` }))
  ]
  return (
    <Stack gap="xs">
      <Select label="Switches act on" value={where} options={options} onChange={(v) => set(context, v)} />
      {where !== GLOBAL && (
        <Select
          label="Save project changes for"
          value={read(saveIn)}
          options={[
            { value: 'local', label: 'Only me (.claude/settings.local.json)' },
            { value: 'project', label: 'The whole team (.claude/settings.json, committed)' }
          ]}
          onChange={(v) => set(saveIn, v === 'project' ? 'project' : 'local')}
        />
      )}
      {where !== GLOBAL && <Text muted size="xs">{where}</Text>}
    </Stack>
  )
}

export function PluginsView({ plugins, projects }: { plugins: Plugin[]; projects: string[] }) {
  const visible = plugins.filter((plugin) => matches(plugin, read(query)))
  const marketplaces = [...new Set(visible.map((plugin) => plugin.marketplace))].sort()
  return (
    <Stack gap="lg">
      <ContextBar projects={projects} />
      {visible.length === 0 && <EmptyState title="No plugins match" />}
      {marketplaces.map((marketplace) => {
        const group = visible.filter((plugin) => plugin.marketplace === marketplace)
        const on = group.filter((plugin) => plugin.enabled).length
        return (
          <Stack key={marketplace} gap="sm">
            <Row justify="between">
              <Heading level={3}>{marketplace || 'no marketplace'}</Heading>
              <Text muted size="xs">{`${on}/${group.length} on globally`}</Text>
            </Row>
            <Grid minItemWidth="sm" gap="sm">
              {group.map((plugin) => (
                <PluginCard key={plugin.id} plugin={plugin} />
              ))}
            </Grid>
          </Stack>
        )
      })}
    </Stack>
  )
}
