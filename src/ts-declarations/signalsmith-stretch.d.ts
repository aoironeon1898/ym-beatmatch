// Types for signalsmith-stretch@1.3.2 (hand-written from its README and source).
// NOTE: patched via patches/signalsmith-stretch@1.3.2.patch so that scheduling with
// `outputTime` keeps earlier future segments.
declare module 'signalsmith-stretch' {
  export interface StretchScheduleOptions {
    /** AudioContext time for this change (use this key, not `output`) */
    outputTime?: number;
    active?: boolean;
    /** seconds within the input buffer */
    input?: number;
    /** input seconds per output second */
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    loopStart?: number;
    loopEnd?: number;
  }

  export interface StretchNode extends AudioWorkletNode {
    inputTime: number;
    schedule(options: StretchScheduleOptions, adjustPrevious?: boolean): Promise<unknown>;
    start(when?: number, offset?: number, duration?: number, rate?: number, semitones?: number): Promise<unknown>;
    stop(when?: number): Promise<unknown>;
    addBuffers(buffers: Float32Array[], transfer?: Transferable[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number } | undefined>;
    latency(): Promise<number>;
    configure(config: { blockMs?: number | null; intervalMs?: number; splitComputation?: boolean; preset?: 'default' | 'cheaper' }): Promise<void>;
    setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): Promise<void>;
  }

  export default function SignalsmithStretch(
    audioContext: BaseAudioContext,
    options?: AudioWorkletNodeOptions,
  ): Promise<StretchNode>;
}
