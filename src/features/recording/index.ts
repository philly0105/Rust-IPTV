/** Public surface of the recording feature: guide reminders and scheduled recordings. */

export { ProgramActions } from './components/ProgramActions';
export { RibbonActions } from './components/RibbonActions';
export { ScheduleMark } from './components/ScheduleMark';
export { RecordingWatcher } from './components/RecordingWatcher';
// Run 2 C5: series recording rules.
export { RecordingRulesPanel } from './components/RulesPanel';
export { RecordSeriesDialog, RemoveRuleDialog, type SeriesTarget } from './components/SeriesDialogs';
// Loop 1: confirm before stopping a running recording.
export { StopRecordingDialog } from './components/StopRecordingDialog';
export {
  setRecordingProgress,
  useRecordingCapabilities,
  useRecordingProgress,
  useRecordingRules,
  useRecordings,
  useReminders,
  useRuleActions,
  useRuleIndex,
  useCancelPending,
  useScheduleActions,
  useScheduleIndex,
} from './hooks';
export * from './lib/schedule';
export * from './lib/rules';
