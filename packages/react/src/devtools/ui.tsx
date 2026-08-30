/**
 * `<OrbitDevtools />` — a floating devtools panel for the react client.
 *
 * The panel is platform-agnostic: it renders ONLY through the injected
 * `primitives` (View/Text/Button/TextInput/ScrollView + styles) and never
 * touches the DOM or React Native APIs directly. The default primitives are
 * plain DOM elements (works in any web app out of the box); on React Native
 * pass the `react-native` components and the same panel renders natively:
 *
 * ```tsx
 * import { View, Text, Pressable, TextInput, ScrollView } from 'react-native';
 * import { OrbitDevtools, type DevtoolsPrimitives } from '@orbit/react/devtools';
 *
 * const rnPrimitives: DevtoolsPrimitives = {
 *   View,
 *   Text,
 *   Button: ({ title, onPress, style, disabled }) => (
 *     <Pressable disabled={disabled} onPress={onPress} style={style}>
 *       <Text style={btnText}>{title}</Text>
 *     </Pressable>
 *   ),
 *   TextInput,
 *   ScrollView,
 * };
 * ```
 *
 * Styles use the flexbox + absolute-positioning subset shared by DOM and RN,
 * and every interactive leaf receives `onPress` (the web primitives translate
 * it to `onClick`).
 *
 * The queries tab supports a search filter, three sort orders (recent /
 * status / key) and an expandable per-row inspector showing the full cached
 * data and entry metadata; the activity tab filters by event type and can
 * clear the feed.
 */
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { OrbitReactClient } from '../client.js';
import type { ActivityEvent, QueryKey } from '../types.js';
import { DevtoolsStore } from './store.js';

export type DevtoolsStyle = Record<string, string | number | undefined>;

export interface DevtoolsPrimitives {
  View: ComponentType<{
    style?: DevtoolsStyle;
    children?: ReactNode;
    testID?: string;
    onPress?: () => void;
  }>;
  Text: ComponentType<{ style?: DevtoolsStyle; children?: ReactNode; numberOfLines?: number }>;
  Button: ComponentType<{
    title: string;
    onPress: () => void;
    style?: DevtoolsStyle;
    disabled?: boolean;
  }>;
  TextInput: ComponentType<{
    value: string;
    onChangeText: (text: string) => void;
    placeholder?: string;
    style?: DevtoolsStyle;
    testID?: string;
  }>;
  ScrollView: ComponentType<{ style?: DevtoolsStyle; children?: ReactNode; testID?: string }>;
}

export interface OrbitDevtoolsProps {
  client: OrbitReactClient;
  /** Render primitives — default to plain DOM elements (web). */
  primitives?: DevtoolsPrimitives;
  /** Whether the panel starts open. Default true. */
  initialOpen?: boolean;
  /** Which corner the collapsed toggle sits in. Default 'bottom-right'. */
  position?: 'bottom-right' | 'bottom-left';
}

// ---------------------------------------------------------------------------
// Default web primitives (DOM)
// ---------------------------------------------------------------------------

function WebView({
  style,
  children,
  testID,
  onPress,
}: {
  style?: DevtoolsStyle;
  children?: ReactNode;
  testID?: string;
  onPress?: () => void;
}) {
  return (
    <div data-testid={testID} onClick={onPress} style={style as CSSProperties}>
      {children}
    </div>
  );
}

function WebText({
  style,
  children,
  numberOfLines,
}: {
  style?: DevtoolsStyle;
  children?: ReactNode;
  numberOfLines?: number;
}) {
  const base: CSSProperties = style as CSSProperties;
  const ellipsis: CSSProperties =
    numberOfLines === 1
      ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
      : {};
  return <span style={{ ...base, ...ellipsis }}>{children}</span>;
}

function WebButton({
  title,
  onPress,
  style,
  disabled,
}: {
  title: string;
  onPress: () => void;
  style?: DevtoolsStyle;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        // Rows and other containers may attach their own onPress — a button
        // click must never toggle the parent's handler too.
        event.stopPropagation();
        onPress();
      }}
      style={style as CSSProperties}
    >
      {title}
    </button>
  );
}

function WebTextInput({
  value,
  onChangeText,
  placeholder,
  style,
  testID,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  style?: DevtoolsStyle;
  testID?: string;
}) {
  return (
    <input
      data-testid={testID}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChangeText(event.target.value)}
      style={style as CSSProperties}
    />
  );
}

function WebScrollView({
  style,
  children,
  testID,
}: {
  style?: DevtoolsStyle;
  children?: ReactNode;
  testID?: string;
}) {
  return (
    <div data-testid={testID} style={{ overflowY: 'auto', ...(style as CSSProperties) }}>
      {children}
    </div>
  );
}

/** The DOM primitives — the default for web apps. */
export const webPrimitives: DevtoolsPrimitives = {
  View: WebView,
  Text: WebText,
  Button: WebButton,
  TextInput: WebTextInput,
  ScrollView: WebScrollView,
};

// ---------------------------------------------------------------------------
// Styles (flexbox + absolute positioning — the DOM/RN shared subset)
// ---------------------------------------------------------------------------

const C = {
  bg: '#0d0d0d',
  panel: '#161616',
  border: '#2a2a2a',
  text: '#ececec',
  dim: '#9a9a9a',
  faint: '#6b6b6b',
  accent: '#10a37f',
  danger: '#f15d6c',
  warn: '#f5b544',
  blue: '#38bdf8',
};

const s = {
  toggle: {
    position: 'absolute',
    bottom: 24,
    zIndex: 2147483647,
  } as DevtoolsStyle,
  toggleBtn: {
    backgroundColor: C.accent,
    borderRadius: 999,
    borderWidth: 0,
    paddingVertical: 8,
    paddingHorizontal: 14,
    color: '#06231b',
    fontWeight: 'bold' as const,
    fontSize: 13,
  } as DevtoolsStyle,
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2147483647,
  } as DevtoolsStyle,
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
  } as DevtoolsStyle,
  panel: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    right: 12,
    maxHeight: '75%',
    backgroundColor: C.panel,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  } as DevtoolsStyle,
  header: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: '#101010',
  } as DevtoolsStyle,
  headerTitle: { color: C.text, fontWeight: 'bold' as const, fontSize: 14 },
  headerStats: { color: C.dim, fontSize: 11, flex: 1 },
  closeBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    color: C.dim,
    fontSize: 12,
    paddingVertical: 3,
    paddingHorizontal: 10,
  } as DevtoolsStyle,
  tabs: {
    display: 'flex',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  } as DevtoolsStyle,
  tab: {
    flex: 1,
    backgroundColor: '#1d1d1d',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    color: C.dim,
    fontSize: 12,
    paddingVertical: 6,
  } as DevtoolsStyle,
  tabActive: {
    backgroundColor: '#14382d',
    borderColor: C.accent,
    color: C.accent,
  } as DevtoolsStyle,
  toolbar: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  } as DevtoolsStyle,
  search: {
    flex: 1,
    backgroundColor: '#1d1d1d',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    color: C.text,
    fontSize: 12,
    paddingVertical: 5,
    paddingHorizontal: 8,
    outlineWidth: 0,
  } as DevtoolsStyle,
  sortBtn: {
    backgroundColor: '#1d1d1d',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    color: C.faint,
    fontSize: 10,
    paddingVertical: 4,
    paddingHorizontal: 8,
  } as DevtoolsStyle,
  body: { maxHeight: 360, padding: 10 },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    backgroundColor: C.bg,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  } as DevtoolsStyle,
  rowTop: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  } as DevtoolsStyle,
  keyText: { color: C.text, fontWeight: 'bold' as const, fontSize: 12.5, flex: 1 },
  chip: {
    borderRadius: 999,
    paddingVertical: 1,
    paddingHorizontal: 8,
    fontSize: 10,
    fontWeight: 'bold' as const,
  } as DevtoolsStyle,
  chipFresh: { backgroundColor: '#14382d', color: C.accent },
  chipStale: { backgroundColor: '#3a2f12', color: C.warn },
  chipLoading: { backgroundColor: '#122a3a', color: C.blue },
  chipError: { backgroundColor: '#3a1418', color: C.danger },
  queryText: { color: C.dim, fontSize: 11, fontFamily: 'monospace' },
  dataText: { color: '#c9d1c9', fontSize: 11, fontFamily: 'monospace', lineHeight: 16 },
  rowMeta: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  } as DevtoolsStyle,
  metaText: { color: C.faint, fontSize: 10, flex: 1 },
  miniBtn: {
    backgroundColor: '#1d1d1d',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    color: C.dim,
    fontSize: 11,
    paddingVertical: 2,
    paddingHorizontal: 8,
  } as DevtoolsStyle,
  inspector: {
    backgroundColor: '#101010',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    padding: 8,
    gap: 6,
  } as DevtoolsStyle,
  inspectorLabel: {
    color: C.accent,
    fontSize: 10,
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
  } as DevtoolsStyle,
  empty: { color: C.faint, fontSize: 12, padding: 16, textAlign: 'center' as const },
  eventRow: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 5,
    paddingHorizontal: 4,
  } as DevtoolsStyle,
  eventType: {
    fontSize: 10,
    fontWeight: 'bold' as const,
    minWidth: 84,
    textTransform: 'uppercase' as const,
  } as DevtoolsStyle,
  eventDetail: { color: C.dim, fontSize: 11, flex: 1 },
  eventTime: { color: C.faint, fontSize: 10 },
  chips: {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  } as DevtoolsStyle,
  chipBtn: {
    backgroundColor: '#1d1d1d',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 999,
    color: C.faint,
    fontSize: 10,
    paddingVertical: 3,
    paddingHorizontal: 8,
  } as DevtoolsStyle,
  footer: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: C.border,
  } as DevtoolsStyle,
  footerBtn: {
    backgroundColor: '#1d1d1d',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    color: C.dim,
    fontSize: 12,
    paddingVertical: 6,
    paddingHorizontal: 12,
  } as DevtoolsStyle,
  dangerBtn: {
    backgroundColor: '#3a1418',
    borderColor: C.danger,
    color: C.danger,
  } as DevtoolsStyle,
};

function formatKey(key: QueryKey): string {
  return typeof key === 'string' ? key : JSON.stringify(key);
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function chipStyle(status: 'fresh' | 'stale' | 'loading' | 'error'): DevtoolsStyle {
  switch (status) {
    case 'fresh':
      return { ...s.chip, ...s.chipFresh };
    case 'stale':
      return { ...s.chip, ...s.chipStale };
    case 'loading':
      return { ...s.chip, ...s.chipLoading };
    default:
      return { ...s.chip, ...s.chipError };
  }
}

function eventColor(type: ActivityEvent['type']): string {
  switch (type) {
    case 'query':
      return C.accent;
    case 'mutation':
      return C.warn;
    case 'subscription':
      return C.blue;
    case 'stream':
      return C.blue;
    case 'invalidate':
      return C.danger;
    default:
      return C.dim;
  }
}

/** Every activity event type — the chip row in the activity tab. */
const ACTIVITY_TYPES: ActivityEvent['type'][] = [
  'query',
  'mutation',
  'subscription',
  'stream',
  'invalidate',
  'setData',
  'clear',
  'hydrate',
];

const PRETTY_CAP = 20_000;

/** Pretty-print the full cached data for the inspector, with a length cap. */
function pretty(data: unknown): string {
  try {
    const text = JSON.stringify(data, null, 2);
    return text.length > PRETTY_CAP
      ? `${text.slice(0, PRETTY_CAP)}\n… (truncated)`
      : text;
  } catch {
    return String(data);
  }
}

const STATUS_RANK: Record<'fresh' | 'stale' | 'loading' | 'error', number> = {
  error: 0,
  loading: 1,
  stale: 2,
  fresh: 3,
};

type QuerySort = 'recent' | 'status' | 'key';

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function OrbitDevtools({
  client,
  primitives = webPrimitives,
  initialOpen = true,
  position = 'bottom-right',
}: OrbitDevtoolsProps) {
  const store = useMemo(() => new DevtoolsStore(client), [client]);
  useEffect(
    () => () => {
      store.close();
    },
    [store],
  );
  const snapshot = useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.getSnapshot(),
  );
  const [open, setOpen] = useState(initialOpen);
  const [tab, setTab] = useState<'queries' | 'subscriptions' | 'activity'>('queries');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<QuerySort>('recent');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [activityFilter, setActivityFilter] = useState<string>('all');

  const { View, Text, Button, TextInput, ScrollView } = primitives;
  const toggleAlign: DevtoolsStyle =
    position === 'bottom-left' ? { left: 24 } : { right: 24 };

  // Queries tab: search filter + sort, applied before render. Computed before
  // the early return so the hook order stays stable across open/close.
  const queryRows = useMemo(() => {
    let rows = snapshot.queries;
    if (filter !== '') {
      const needle = filter.toLowerCase();
      rows = rows.filter((row) =>
        `${formatKey(row.key)} ${row.query}`.toLowerCase().includes(needle),
      );
    }
    return [...rows].sort((a, b) => {
      if (sort === 'recent') return b.fetchedAt - a.fetchedAt;
      if (sort === 'key') return formatKey(a.key).localeCompare(formatKey(b.key));
      return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    });
  }, [snapshot.queries, filter, sort]);

  // Activity tab: a stable chip row (all types) + clear-feed action.
  const activityRows =
    activityFilter === 'all'
      ? snapshot.events
      : snapshot.events.filter((event) => event.type === activityFilter);

  if (!open) {
    return (
      <View testID="orbit-devtools-toggle" style={{ ...s.toggle, ...toggleAlign }}>
        <Button title="🔮 Orbit" onPress={() => setOpen(true)} style={s.toggleBtn} />
      </View>
    );
  }

  const stats = snapshot.stats;
  const hitRatio =
    stats.hits + stats.misses === 0
      ? '—'
      : `${Math.round((stats.hits / (stats.hits + stats.misses)) * 100)}%`;
  const avg =
    stats.avgQueryMs === undefined ? '—' : `${stats.avgQueryMs}ms avg query`;

  const toggleRow = (cacheKey: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cacheKey)) next.delete(cacheKey);
      else next.add(cacheKey);
      return next;
    });
  };

  return (
    <View testID="orbit-devtools" style={s.overlay}>
      <View testID="orbit-devtools-backdrop" style={s.backdrop} onPress={() => setOpen(false)} />
      <View testID="orbit-devtools-panel" style={s.panel}>
        <View style={s.header}>
          <Text style={s.headerTitle}>🔮 Orbit devtools</Text>
          <Text style={s.headerStats}>
            {stats.entries} entries · {hitRatio} hit · {avg}
          </Text>
          <Button title="close" onPress={() => setOpen(false)} style={s.closeBtn} />
        </View>

        <View style={s.tabs}>
          <Button
            title={`Queries (${snapshot.queries.length})`}
            onPress={() => setTab('queries')}
            style={tab === 'queries' ? { ...s.tab, ...s.tabActive } : s.tab}
          />
          <Button
            title={`Subscriptions (${snapshot.subscriptions.length})`}
            onPress={() => setTab('subscriptions')}
            style={tab === 'subscriptions' ? { ...s.tab, ...s.tabActive } : s.tab}
          />
          <Button
            title={`Activity (${snapshot.events.length})`}
            onPress={() => setTab('activity')}
            style={tab === 'activity' ? { ...s.tab, ...s.tabActive } : s.tab}
          />
        </View>

        {tab === 'queries' && (
          <View style={s.toolbar}>
            <TextInput
              testID="orbit-devtools-search"
              value={filter}
              onChangeText={setFilter}
              placeholder="filter queries…"
              style={s.search}
            />
            <Button
              title="recent"
              onPress={() => setSort('recent')}
              style={sort === 'recent' ? { ...s.sortBtn, ...s.tabActive } : s.sortBtn}
            />
            <Button
              title="status"
              onPress={() => setSort('status')}
              style={sort === 'status' ? { ...s.sortBtn, ...s.tabActive } : s.sortBtn}
            />
            <Button
              title="key"
              onPress={() => setSort('key')}
              style={sort === 'key' ? { ...s.sortBtn, ...s.tabActive } : s.sortBtn}
            />
          </View>
        )}

        <ScrollView testID="orbit-devtools-body" style={s.body}>
          {tab === 'queries' && (
            <>
              {queryRows.length === 0 && (
                <Text style={s.empty}>
                  {filter === ''
                    ? 'No cached queries yet — run a query and watch it land here.'
                    : 'No queries match the filter.'}
                </Text>
              )}
              {queryRows.map((row) => {
                const isExpanded = expanded.has(row.cacheKey);
                return (
                  <View
                    key={row.cacheKey}
                    testID={`query-${row.cacheKey}`}
                    style={s.row}
                    onPress={() => toggleRow(row.cacheKey)}
                  >
                    <View style={s.rowTop}>
                      <Text style={s.keyText}>{formatKey(row.key)}</Text>
                      <Text style={chipStyle(row.status)}>{row.status}</Text>
                    </View>
                    <Text style={s.queryText} numberOfLines={1}>
                      {row.query}
                    </Text>
                    <Text style={s.dataText} numberOfLines={2}>
                      {row.hasData ? row.dataPreview : row.errorMessage ?? 'fetching…'}
                    </Text>
                    <View style={s.rowMeta}>
                      <Text style={s.metaText}>
                        {row.hasData
                          ? `${fmtMs(row.ttlLeftMs)} ttl · ${row.fromCache ? 'server-cached' : 'network'} · ${timeOf(row.fetchedAt)}`
                          : row.status === 'error'
                            ? `failed · ${timeOf(row.fetchedAt)}`
                            : `fetching · ${timeOf(row.fetchedAt)}`}
                      </Text>
                      <Button
                        title={isExpanded ? '▾' : '▸'}
                        onPress={() => toggleRow(row.cacheKey)}
                        style={s.miniBtn}
                      />
                      <Button title="⟳" onPress={() => store.refetch(row.key, row.query)} style={s.miniBtn} />
                      <Button title="✕" onPress={() => store.invalidate(row.key)} style={s.miniBtn} />
                    </View>
                    {isExpanded && (
                      <View style={s.inspector}>
                        {row.hasData && (
                          <>
                            <Text style={s.inspectorLabel}>data</Text>
                            <Text style={s.dataText}>{pretty(row.data)}</Text>
                          </>
                        )}
                        {row.status === 'error' && (
                          <>
                            <Text style={s.inspectorLabel}>error</Text>
                            <Text style={s.dataText}>
                              {row.errorMessage}
                              {row.errorCode !== undefined ? ` [${row.errorCode}]` : ''}
                            </Text>
                          </>
                        )}
                        {!row.hasData && row.status !== 'error' && (
                          <Text style={s.metaText}>no data yet — fetch in flight…</Text>
                        )}
                        <Text style={s.inspectorLabel}>meta</Text>
                        <Text style={s.metaText}>
                          fetched {timeOf(row.fetchedAt)}
                          {row.hasData
                            ? ` · fresh until ${timeOf(row.expiresAt)} · stale until ${timeOf(row.staleAt)} · ${row.fromCache ? 'server-cached' : 'network'}`
                            : ''}
                          {row.entities.length > 0
                            ? ` · entities: ${row.entities.join(', ')}`
                            : ''}
                        </Text>
                      </View>
                    )}
                  </View>
                );
              })}
            </>
          )}

          {tab === 'subscriptions' && (
            <>
              {snapshot.subscriptions.length === 0 && (
                <Text style={s.empty}>No active subscriptions.</Text>
              )}
              {snapshot.subscriptions.map((sub) => (
                <View key={`${sub.key}-${sub.query}`} style={s.row}>
                  <View style={s.rowTop}>
                    <Text style={s.keyText}>{formatKey(sub.key)}</Text>
                    <Text style={{ ...s.chip, ...s.chipFresh }}>{sub.status}</Text>
                  </View>
                  <Text style={s.queryText} numberOfLines={1}>
                    {sub.query}
                  </Text>
                  <Text style={s.metaText}>seq {sub.seq}</Text>
                </View>
              ))}
            </>
          )}

          {tab === 'activity' && (
            <>
              {snapshot.events.length === 0 && (
                <Text style={s.empty}>Nothing yet — queries, mutations, subscriptions and invalidations land here.</Text>
              )}
              {snapshot.events.length > 0 && (
                <View style={s.chips}>
                  <Button
                    title="all"
                    onPress={() => setActivityFilter('all')}
                    style={activityFilter === 'all' ? { ...s.chipBtn, ...s.tabActive } : s.chipBtn}
                  />
                  {ACTIVITY_TYPES.map((type) => (
                    <Button
                      key={type}
                      title={type}
                      onPress={() => setActivityFilter(type)}
                      style={activityFilter === type ? { ...s.chipBtn, ...s.tabActive } : s.chipBtn}
                    />
                  ))}
                  <Button
                    title="✕ clear feed"
                    onPress={() => store.clearEvents()}
                    style={{ ...s.chipBtn, ...s.dangerBtn }}
                  />
                </View>
              )}
              {activityRows.length === 0 && snapshot.events.length > 0 && (
                <Text style={s.empty}>No events of this type.</Text>
              )}
              {activityRows.map((event) => (
                <View key={event.id} style={s.eventRow}>
                  <Text style={{ ...s.eventType, color: eventColor(event.type) }}>
                    {event.type}
                  </Text>
                  <Text style={s.eventDetail} numberOfLines={1}>
                    {event.detail ??
                      (event.key !== undefined ? formatKey(event.key) : undefined) ??
                      event.action ??
                      ''}
                    {event.ms !== undefined ? ` · ${fmtMs(event.ms)}` : ''}
                  </Text>
                  <Text style={s.eventTime}>{timeOf(event.at)}</Text>
                </View>
              ))}
            </>
          )}
        </ScrollView>

        <View style={s.footer}>
          <Button
            title="⟳ refetch all"
            onPress={() => {
              for (const row of snapshot.queries) store.refetch(row.key, row.query);
            }}
            style={s.footerBtn}
          />
          <Button title="✕ clear cache" onPress={() => store.clear()} style={{ ...s.footerBtn, ...s.dangerBtn }} />
        </View>
      </View>
    </View>
  );
}
