/** Public surface of the recording feature: guide reminders and scheduled recordings. */

export { ProgramActions } from './components/ProgramActions';
export { RibbonActions } from './components/RibbonActions';
export { ScheduleMark } from './components/ScheduleMark';
export { RecordingWatcher } from './components/RecordingWatcher';
// Run 2 C5: series recording rules.
export { RecordingRulesPanel } from './components/RulesPanel';
export { RecordSeriesDialog, RemoveRuleDialog, type SeriesTarget } from './components/SeriesDialogs';
export {
  setRecordingProgress,
  useRecordingCapabilities,
  useRecordingProgress,
  useRecordingRules,
  useRecordings,
  useReminders,
  useRuleActions,
  useRuleIndex,
  useScheduleActions,
  useScheduleIndex,
} from './hooks';
export * from './lib/schedule';
export * from './lib/rules';
