/**
 * VirtualizedList + maintainVisibleContentPosition: after a large prepend, an
 * interior spacer above the viewport is re-estimated whenever a cell mounts or
 * unmounts at the render window's leading edge, and the list and the mVCP
 * anchor fall into a 2-cycle. See README.md.
 *
 * @format
 */

import { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

const INITIAL_ROWS = 200;
const PREPEND_ROWS = 50;
/** How far down to scroll before prepending, in points. */
const SCROLL_BEFORE_PREPEND = 3000;

type Row = { id: number; height: number };

/**
 * Deterministic but varied row height in [60, 600], from a mulberry32 step
 * seeded with the row id.
 */
/* eslint-disable no-bitwise */
function heightFor(id: number): number {
  let t = (id * 7919 + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return 60 + Math.round(r * 540);
}
/* eslint-enable no-bitwise */

function makeRows(firstId: number, count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: firstId + i,
    height: heightFor(firstId + i),
  }));
}

/*
 * Scroll stats live outside React so that updating them never re-renders the
 * list. The readout polls them.
 */
const stats = {
  t0: Date.now(),
  y: 0,
  h: 0,
  lastDySign: 0,
  /** Timestamps of offset reversals (dy changing sign). */
  reversals: [] as number[],
  /** Scroll events where the offset moved with the content height. */
  corrections: 0,
  /** Corrections that undid the previous one within 300 ms. */
  ring: 0,
  lastCorrection: null as null | { dh: number; t: number },
  maxSwing: 0,
};

function resetStats() {
  stats.t0 = Date.now();
  stats.y = 0;
  stats.h = 0;
  stats.lastDySign = 0;
  stats.reversals = [];
  stats.corrections = 0;
  stats.ring = 0;
  stats.lastCorrection = null;
  stats.maxSwing = 0;
}

function fmt(n: number) {
  return (n >= 0 ? '+' : '') + n.toFixed(1);
}

function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
  const t = Date.now();
  const y = e.nativeEvent.contentOffset.y;
  const h = e.nativeEvent.contentSize.height;
  const dy = y - stats.y;
  const dh = stats.h === 0 ? 0 : h - stats.h;
  stats.y = y;
  stats.h = h;

  if (Math.abs(dy) >= 1) {
    const sign = Math.sign(dy);
    if (stats.lastDySign !== 0 && sign !== stats.lastDySign) {
      stats.reversals.push(t);
    }
    stats.lastDySign = sign;
  }

  /*
   * maintainVisibleContentPosition moves the offset by exactly as much as the
   * content above the anchor changed size, so an event whose offset moved with
   * the content height is an anchor correction rather than user movement.
   */
  let tag = '';
  if (Math.abs(dh) >= 20 && Math.abs(dy - dh) <= 2) {
    stats.corrections++;
    tag = ` correction #${stats.corrections}`;
    const prev = stats.lastCorrection;
    if (prev && Math.sign(prev.dh) !== Math.sign(dh) && t - prev.t < 300) {
      stats.ring++;
      stats.maxSwing = Math.max(stats.maxSwing, Math.abs(dh));
      tag += ` RING #${stats.ring} (${t - prev.t}ms after ${fmt(prev.dh)})`;
    }
    stats.lastCorrection = { dh, t };
  }

  if (Math.abs(dy) >= 0.5 || dh !== 0) {
    console.log(
      `[ring] +${t - stats.t0}ms y=${y.toFixed(1)} (dy=${fmt(dy)}) ` +
        `h=${h.toFixed(1)} (dh=${fmt(dh)})${tag}`,
    );
  }
}

function Readout({ fix }: { fix: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 100);
    return () => clearInterval(id);
  }, []);
  const now = Date.now();
  const reversalsPerSecond = stats.reversals.filter(r => now - r < 1000).length;
  return (
    <View style={styles.readout}>
      <Text style={styles.readoutText}>
        {fix ? 'FIXED (measureInteriorSpacers)' : 'STOCK'}
      </Text>
      <Text style={styles.readoutText}>
        contentOffset.y {stats.y.toFixed(1)} · contentSize.height{' '}
        {stats.h.toFixed(1)}
      </Text>
      <Text
        style={[
          styles.readoutText,
          reversalsPerSecond > 2 ? styles.bad : undefined,
        ]}
      >
        reversals in last 1s: {reversalsPerSecond}
      </Text>
      <Text
        style={[styles.readoutText, stats.ring > 0 ? styles.bad : undefined]}
      >
        ring: {stats.ring} · corrections: {stats.corrections} · max swing{' '}
        {stats.maxSwing.toFixed(0)}pt
      </Text>
    </View>
  );
}

function RowView({ item }: { item: Row }) {
  return (
    <View
      style={[
        styles.row,
        {
          height: item.height,
          backgroundColor: `hsl(${(item.id * 47) % 360}, 60%, 85%)`,
        },
      ]}
    >
      <Text style={styles.rowText}>
        row {item.id} · {item.height}pt
      </Text>
    </View>
  );
}

function ControlButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function App() {
  const listRef = useRef<FlatList<Row>>(null);
  const [fix, setFix] = useState(false);
  const [runId, setRunId] = useState(0);
  const [rows, setRows] = useState(() => makeRows(0, INITIAL_ROWS));
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const reset = (nextFix = fix) => {
    clearTimers();
    resetStats();
    console.log(`[ring] reset, ${nextFix ? 'FIXED' : 'STOCK'}`);
    setRows(makeRows(0, INITIAL_ROWS));
    setRunId(n => n + 1);
  };

  const prepend = () => {
    setRows(prev => {
      const firstId = prev[0].id - PREPEND_ROWS;
      console.log(
        `[ring] +${Date.now() - stats.t0}ms prepending ${PREPEND_ROWS} rows ` +
          `(${firstId}..${firstId + PREPEND_ROWS - 1}) at y=${stats.y.toFixed(
            1,
          )} h=${stats.h.toFixed(1)}`,
      );
      return [...makeRows(firstId, PREPEND_ROWS), ...prev];
    });
  };

  /** Reset, scroll a few screens down, then prepend. */
  const run = () => {
    reset();
    timers.current.push(
      setTimeout(() => {
        listRef.current?.scrollToOffset({
          offset: SCROLL_BEFORE_PREPEND,
          animated: false,
        });
      }, 1000),
      setTimeout(prepend, 2000),
    );
  };

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.controls}>
          <ControlButton label="Run" onPress={run} />
          <ControlButton label={`Prepend ${PREPEND_ROWS}`} onPress={prepend} />
          <ControlButton label="Reset" onPress={() => reset()} />
          <View style={styles.fixToggle}>
            <Text style={styles.buttonText}>Fix</Text>
            <Switch
              accessibilityLabel="Fix"
              value={fix}
              onValueChange={value => {
                setFix(value);
                reset(value);
              }}
            />
          </View>
        </View>
        <Readout fix={fix} />
        <FlatList
          key={runId}
          ref={listRef}
          style={styles.list}
          data={rows}
          keyExtractor={item => String(item.id)}
          renderItem={({ item }) => <RowView item={item} />}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onScroll={onScroll}
          scrollEventThrottle={16}
          // @ts-expect-error: added by patches/@react-native+virtualized-lists+0.87.1.patch
          measureInteriorSpacers={fix}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'white' },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#e5e7eb',
  },
  pressed: { opacity: 0.6 },
  buttonText: { fontSize: 15, fontWeight: '600' },
  fixToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
  },
  readout: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#999',
  },
  readoutText: { fontFamily: 'Menlo', fontSize: 12 },
  bad: { color: '#dc2626', fontWeight: '700' },
  list: { flex: 1 },
  row: {
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#666',
  },
  rowText: { fontSize: 16 },
});

export default App;
