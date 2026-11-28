import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const jarPath = resolve(process.env['TLC_JAR'] ?? 'tla2tools.jar');
assert.equal(
  createHash('sha1').update(readFileSync(jarPath)).digest('hex'),
  'bee4a54f3ee3d4afc347c3240ec2d9e93b075104',
  'Use the published TLC 1.7.4 jar',
);

type VerificationCase = readonly [model: string, configuration: string, expectedInvariant?: string];

const models: readonly VerificationCase[] = [
  ['DuplicateConnack', 'DuplicateConnack'],
  ['DuplicateConnack', 'DuplicateConnackGuard', 'SecondReceiptRetires'],
  ['DuplicateConnack', 'DuplicateConnackLate', 'SecondReceiptRetires'],
  ['DuplicateConnack', 'DuplicateConnackActiveOnly', 'SecondReceiptRetires'],
  ['SessionPresentAgreement', 'SessionPresentAgreement'],
  ['SessionPresentAgreement', 'SessionPresentAgreementGuard', 'PresentRetires'],
  ['SessionPresentAgreement', 'SessionPresentAgreementRefusal', 'RefusedPresentIsProtocol'],
  ['ConnackAgreement', 'ConnackAgreement'],
  ['ConnackAgreement', 'ConnackAgreementMethod', 'ValidateBeforeAcceptance'],
  ['ConnackAgreement', 'ConnackAgreementData', 'ValidateBeforeAcceptance'],
  ['ConnackAgreement', 'ConnackAgreementAssignment', 'ValidateBeforeAcceptance'],
  ['ConnackAgreement', 'ConnackAgreementLate', 'ValidateBeforeAcceptance'],
  ['ConnackAgreement', 'ConnackAgreementAuth', 'UnsolicitedAuthRetires'],
  ['ConnackAgreement', 'ConnackAgreementSnapshot', 'CapturedIdentitySent'],
  ['PingFence', 'PingFence'],
  ['PingFence', 'PingFenceBroken', 'NoWrongReply'],
  ['PingFence', 'PingFenceRetry', 'NoSendAfterFailure'],
  ['WebSocketOpen', 'WebSocketOpen'],
  ['WebSocketOpen', 'WebSocketOpenBroken', 'TerminalOwnership'],
  ['WebSocketSession', 'WebSocketSession'],
  ['WebSocketSession', 'WebSocketSessionDeliver', 'NoInvalidDelivery'],
  ['WebSocketSession', 'WebSocketSessionBudget', 'BoundedBudget'],
  ['BrowserTransport', 'BrowserTransport'],
  ['BrowserTransport', 'BrowserTransportDelivery', 'NoLateDelivery'],
  ['BrowserTransport', 'BrowserTransportBudget', 'BoundedAdmission'],
  ['BrowserTransport', 'BrowserTransportObserver', 'NativeCloseSettles'],
  ['CodecFrames', 'CodecFrames'],
  ['CodecFrames', 'CodecFramesAllocation', 'BoundedAllocation'],
  ['CodecFrames', 'CodecFramesEarly', 'CompleteBeforeEmit'],
  ['CodecFrames', 'CodecFramesPoison', 'NoOutputAfterFailure'],
  ['CodecEndOfInput', 'CodecEndOfInput'],
  ['CodecEndOfInput', 'CodecEndOfInputTruncated', 'RejectTruncatedEnd'],
  ['CodecEndOfInput', 'CodecEndOfInputOutput', 'NoOutputAfterEnd'],
  ['CodecEndOfInput', 'CodecEndOfInputFailure', 'PreserveFailure'],
  ['BrowserClientHandoff', 'BrowserClientHandoff'],
  ['BrowserClientHandoff', 'BrowserClientHandoffAbort', 'NoCancelledTransfer'],
  ['BrowserClientHandoff', 'BrowserClientHandoffForce', 'ForceWithoutNativeWait'],
  ['BrowserDecoderClose', 'BrowserDecoderClose'],
  ['BrowserDecoderClose', 'BrowserDecoderCloseOmit', 'RemoteTruncation'],
  ['BrowserDecoderClose', 'BrowserDecoderCloseReplace', 'PreserveOtherCause'],
  ['BrowserDecoderClose', 'BrowserDecoderCloseRepeat', 'FinishAtMostOnce'],
  ['MessageQueueOwnership', 'MessageQueueOwnership'],
  ['MessageQueueOwnership', 'MessageQueueOwnershipBudget', 'BoundedQueue'],
  ['MessageQueueOwnership', 'MessageQueueOwnershipDelivery', 'NoLateDelivery'],
  ['MessageQueueOwnership', 'MessageQueueOwnershipCancel', 'ConsumerDoesNotOwnProtocol'],
  ['MessageQueueOwnership', 'MessageQueueOwnershipWaiter', 'BoundedWaiters'],
  ['StreamTerminal', 'StreamTerminal'],
  ['StreamTerminal', 'StreamTerminalClose', 'EmptyCompletion'],
  ['StreamTerminal', 'StreamTerminalFailure', 'FailureSettles'],
  ['StreamTerminal', 'StreamTerminalHandoff', 'PreserveHandedMessage'],
  ['ReadyBatch', 'ReadyBatch'],
  ['ReadyBatch', 'ReadyBatchItems', 'BatchItemLimit'],
  ['ReadyBatch', 'ReadyBatchBytes', 'BatchByteLimit'],
  ['ReadyBatch', 'ReadyBatchSkip', 'BatchFifo'],
  ['ReadyBatch', 'ReadyBatchOverlap', 'SinglePendingBatch'],
  ['ReadyBatch', 'ReadyBatchTerminal', 'NoBatchAfterStop'],
  ['SessionEndNotice', 'SessionEndNotice'],
  ['SessionEndNotice', 'SessionEndNoticeOmit', 'RetirementQueuesNotice'],
  ['SessionEndNotice', 'SessionEndNoticeRepeat', 'OneRetirementNotice'],
  ['SessionEndNotice', 'SessionEndNoticeReplace', 'NoticeUsesFirstCause'],
  ['SessionEndNotice', 'SessionEndNoticeEarly', 'ProtocolNoticeStartsFirst'],
  ['WebSocketReceive', 'WebSocketReceive'],
  ['WebSocketReceive', 'WebSocketReceiveBudget', 'BoundedReceive'],
  ['WebSocketReceive', 'WebSocketReceiveLate', 'NoLateReceive'],
  ['NodeCancellation', 'NodeCancellation'],
  ['NodeCancellation', 'NodeCancellationDetach', 'ActiveOwnsSignal'],
  ['NodeCancellation', 'NodeCancellationNotify', 'AbortRetiresActive'],
  ['NodeCancellation', 'NodeCancellationCleanup', 'ClosedReleasesSignal'],
  ['NodeReceive', 'NodeReceive'],
  ['NodeReceive', 'NodeReceiveValidate', 'InvalidConfigNoConstruction'],
  ['NodeReceive', 'NodeReceiveForward', 'BoundedNativeReceive'],
  ['NodeReceive', 'NodeReceiveNotify', 'ErrorRetiresCore'],
  ['NodeReceive', 'NodeReceiveTerminate', 'ErrorRequestsTermination'],
  ['NodePacketAdmission', 'NodePacketAdmission'],
  ['NodePacketAdmission', 'NodePacketAdmissionBudget', 'BoundedPacketAdmission'],
  ['NodePacketAdmission', 'NodePacketAdmissionEarly', 'CompleteBeforeDecode'],
  ['NodePacketAdmission', 'NodePacketAdmissionPoison', 'PermanentFailure'],
  ['NodePacketAdmission', 'NodePacketAdmissionRetire', 'RetirementFenced'],
  ['NodePacketAdmission', 'NodePacketAdmissionEof', 'RejectTruncatedCompletion'],
  ['NodeCanonicalLength', 'NodeCanonicalLength'],
  ['NodeCanonicalLength', 'NodeCanonicalLengthSkip', 'CanonicalBeforeAdmission'],
  ['PropertyCardinalityValues', 'PropertyCardinalityValues'],
  ['PropertyCardinalityValues', 'PropertyCardinalityValuesDuplicate', 'SingletonsBeforeDispatch'],
  ['PropertyCardinalityValues', 'PropertyCardinalityValuesScalar', 'ScalarsBeforeDispatch'],
  ['PropertyCardinalityValues', 'PropertyCardinalityValuesRepeat', 'AllowedRepetitionPreserved'],
  ['DisconnectPropertyLayout', 'DisconnectPropertyLayout'],
  ['DisconnectPropertyLayout', 'DisconnectPropertyLayoutGuard', 'PropertiesBeforeInterpretation'],
  ['DisconnectPropertyLayout', 'DisconnectPropertyLayoutCompact', 'CompactPreserved'],
  ['AckPropertyLayout', 'AckPropertyLayout'],
  ['AckPropertyLayout', 'AckPropertyLayoutGuard', 'PropertiesCheckedBeforeDispatch'],
  ['AckPropertyLayout', 'AckPropertyLayoutCompact', 'CompactFormsAccepted'],
  ['AckPropertyLayout', 'AckPropertyLayoutSubscription', 'PropertiesCheckedBeforeDispatch'],
  ['NodeConnackProperties', 'NodeConnackProperties'],
  ['NodeConnackProperties', 'NodePublishProperties'],
  ['NodeConnackProperties', 'NodePublishPropertiesString', 'ValidateBeforeDelivery'],
  ['NodeConnackProperties', 'NodePublishPropertiesBounds', 'BoundedCursor'],
  ['NodeConnackProperties', 'NodePublishPropertiesIdentifier', 'ValidateBeforeDelivery'],
  ['NodeConnackProperties', 'NodePublishPropertiesCanonical', 'ValidateBeforeDelivery'],
  ['NodeConnackProperties', 'NodePublishPropertiesPayload', 'BoundedCursor'],

  ['NodeConnackProperties', 'NodeConnackPropertiesString', 'ValidateBeforeDelivery'],
  ['NodeConnackProperties', 'NodeConnackPropertiesBounds', 'BoundedCursor'],
  ['NodeConnackProperties', 'NodeConnackPropertiesIdentifier', 'ValidateBeforeDelivery'],
  ['NodeConnackProperties', 'NodeConnackPropertiesCanonical', 'ValidateBeforeDelivery'],
  ['NodePublishTopic', 'NodePublishTopic'],
  ['NodePublishTopic', 'NodePublishTopicSkip', 'ValidateBeforeDelivery'],
  ['NodeInputLifecycle', 'NodeInputLifecycle'],
  ['NodeInputLifecycle', 'NodeInputLifecycleReplay', 'ReplayInstalled'],
  ['NodeInputLifecycle', 'NodeInputLifecycleStop', 'RetirementStopsDecoder'],
  ['NodeInputLifecycle', 'NodeInputLifecycleLate', 'NoDecoderReadAfterTerminal'],
  ['NodeInputLifecycle', 'NodeInputLifecycleOrder', 'NotificationOwnsCause'],
  ['NodeInputLifecycle', 'NodeInputLifecycleEof', 'RemoteTruncation'],
  ['NodeInputLifecycle', 'NodeInputLifecycleRepeat', 'FinishAtMostOnce'],
  ['NodeInputLifecycle', 'NodeInputLifecycleOverwrite', 'PreserveInputCause'],
  ['NodeInputLifecycle', 'NodeInputLifecycleLeak', 'NoSyntheticLeak'],
  ['ConnectRefusal', 'ConnectRefusal'],
  ['ConnectRefusal', 'ConnectRefusalDefer', 'FirstTerminalReason'],
  ['ConnectRefusal', 'ConnectRefusalOverwrite', 'FirstTerminalReason'],
  ['TimeoutAdmission', 'TimeoutAdmission'],
  ['TimeoutAdmission', 'TimeoutAdmissionValidate', 'ValidateBeforeAcquire'],
  ['TimeoutAdmission', 'TimeoutAdmissionSnapshot', 'RetainAcceptedDeadline'],
  ['OperationTimeout', 'OperationTimeout'],
  ['OperationTimeout', 'OperationTimeoutDefer', 'NoAdmissionAfterTimeout'],
  ['OperationTimeout', 'OperationTimeoutSingle', 'AllPendingRetired'],
  ['OperationTimeout', 'OperationTimeoutDuplicate', 'OneForcedClose'],
  ['OperationTimeout', 'OperationTimeoutOverwrite', 'FirstTimeoutCause'],
  ['QosZeroDeadline', 'QosZeroDeadline'],
  ['QosZeroDeadline', 'QosZeroDeadlineEarly', 'RetiresAtOwnDeadline'],
  ['QosZeroDeadline', 'QosZeroDeadlineDrop', 'TimerCoversWrites'],
  ['QosZeroDeadline', 'QosZeroDeadlinePending', 'ClearsPendingOnRetire'],
  ['PublicationAdmission', 'PublicationAdmission'],
  ['PublicationAdmission', 'PublicationAdmissionItems', 'BoundedItems'],
  ['PublicationAdmission', 'PublicationAdmissionBytes', 'BoundedBytes'],
  ['PublicationAdmission', 'PublicationAdmissionRelease', 'PendingCovered'],
  ['PublicationAdmission', 'PublicationAdmissionControl', 'ControlAvailable'],
  ['NativeWriteReserve', 'NativeWriteReserve'],
  ['NativeWriteReserve', 'NativeWriteReserveTotal', 'BoundedProjection'],
  ['NativeWriteReserve', 'NativeWriteReserveHeadroom', 'PublicationHeadroom'],
  ['NativeWriteReserve', 'NativeWriteReserveInvalid', 'ValidObservation'],
  ['SubscriptionOwnership', 'SubscriptionOwnership'],
  ['SubscriptionOwnership', 'SubscriptionOwnershipItems', 'BoundedItems'],
  ['SubscriptionOwnership', 'SubscriptionOwnershipBytes', 'BoundedBytes'],
  ['SubscriptionOwnership', 'SubscriptionOwnershipReuse', 'OwnedUntilComplete'],
  ['SubscriptionOwnership', 'SubscriptionOwnershipEarly', 'NoEarlyRelease'],
  ['SubscriptionOwnership', 'SubscriptionOwnershipKind', 'NoWrongKind'],
  ['SubscriptionOwnership', 'SubscriptionOwnershipStale', 'OwnedUntilComplete'],
  ['SubscriptionOwnership', 'SubscriptionOwnershipRetired', 'NoAdmissionAfterRetirement'],
  ['SubscriptionOwnership', 'SubscriptionOwnershipMalformed', 'InvalidMatchingAckRetires'],
  ['DisconnectDrain', 'DisconnectDrain'],
  ['DisconnectDrain', 'DisconnectDrainLate', 'NoSendAfterStop'],
  ['DisconnectDrain', 'DisconnectDrainEarly', 'DrainBeforeDisconnect'],
  ['DisconnectDrain', 'DisconnectDrainOutcome', 'DeadlinePreservesOutcome'],
  ['QosOneOutbound', 'QosOneOutbound'],
  ['QosOneOutbound', 'QosOneOutboundQuota', 'BoundedQuota'],
  ['QosOneOutbound', 'QosOneOutboundItems', 'BoundedItems'],
  ['QosOneOutbound', 'QosOneOutboundBytes', 'BoundedBytes'],
  ['QosOneOutbound', 'QosOneOutboundId', 'SharedIds'],
  ['QosOneOutbound', 'QosOneOutboundAck', 'NoWrongAck'],
  ['QosOneOutbound', 'QosOneOutboundEarly', 'HeldUntilSettled'],
  ['QosOneOutbound', 'QosOneOutboundActiveAbort', 'HeldUntilSettled'],
  ['QosOneOutbound', 'QosOneOutboundQueuedAbort', 'CanceledQueueNeverDispatches'],
  ['QosOneOutbound', 'QosOneOutboundStop', 'NoDispatchAfterStop'],
  ['QosOneOutbound', 'QosOneOutboundTerminal', 'HeldUntilSettled'],
  ['QosOneNativeAdmission', 'QosOneNativeAdmission'],
  ['QosOneNativeAdmission', 'QosOneNativeAdmissionRetire', 'RefusalKeepsSession'],
  ['QosOneNativeAdmission', 'QosOneNativeAdmissionLease', 'RefusalReleasesIdentifier'],
  ['QosOneNativeAdmission', 'QosOneNativeAdmissionPublication', 'RefusalReleasesPublication'],
  ['QosOneNativeAdmission', 'QosOneNativeAdmissionUncertain', 'UncertainRetires'],
  ['QosOneNativeAdmission', 'QosOneNativeAdmissionReplay', 'ReplayRetires'],
  ['QosOneInbound', 'QosOneInbound'],
  ['QosOneInbound', 'QosOneInboundBudget', 'BoundedFollower'],
  ['QosOneInbound', 'QosOneInboundOpening', 'PreserveOpeningMessage'],
  ['QosOneInbound', 'QosOneInboundEarly', 'AckAfterHandler'],
  ['QosOneInbound', 'QosOneInboundLate', 'NoAckAfterStop'],
  ['QosOneInbound', 'QosOneInboundAdvance', 'NoDispatchBeforeAckSettles'],
  ['QosOneInbound', 'QosOneInboundRetention', 'TerminalClearsFollower'],
  ['QosOneInbound', 'QosOneInboundForce', 'GracefulCloseOwnsRetirement'],
  ['QosTwoOutbound', 'QosTwoOutbound'],
  ['QosTwoOutbound', 'QosTwoOutboundQuota', 'HeldUntilComplete'],
  ['QosTwoOutbound', 'QosTwoOutboundRefused', 'ReleaseAfterAccept'],
  ['QosTwoOutbound', 'QosTwoOutboundReplay', 'NoPublishAfterRelease'],
  ['QosTwoOutbound', 'QosTwoOutboundEarly', 'ResolveOnComplete'],
  ['QosTwoOutbound', 'QosTwoOutboundLate', 'NoReleaseAfterDisconnect'],
  ['QosTwoOutbound', 'QosTwoOutboundOutcome', 'ResolveOnComplete'],
  ['QosTwoOutbound', 'QosTwoOutboundHeld', 'ReleaseNotDelayed'],
  ['QosTwoInbound', 'QosTwoInbound'],
  ['QosTwoInbound', 'QosTwoInboundDuplicate', 'DeliveredOnce'],
  ['QosTwoInbound', 'QosTwoInboundRestart', 'DeliveredOnce'],
  ['QosTwoInbound', 'QosTwoInboundSlot', 'BoundedWindow'],
  ['QosTwoInbound', 'QosTwoInboundKeep', 'FailedHandlerForgets'],
  ['QosTwoInbound', 'QosTwoInboundLate', 'NoAnswerAfterStop'],
  ['QosTwoInbound', 'QosTwoInboundShared', 'DeliveredOnce'],
  ['QosTwoInbound', 'QosTwoInboundSharedSlot', 'SlotHeldUntilRelease'],
  ['QosTwoInbound', 'QosTwoInboundImmediate', 'AcknowledgedIsFulfilled'],
  ['QosTwoInbound', 'QosTwoInboundRelease', 'AcknowledgedIsFulfilled'],
  ['QosTwoInbound', 'QosTwoInboundSilent', 'HeldWaitsForHandler'],
  ['QosTwoInbound', 'QosTwoInboundStale', 'AcknowledgedIsDelivered'],
  ['ParserAckNotice', 'ParserAckNotice'],
  ['ParserAckNotice', 'ParserAckNoticeRead', 'InputFenced'],
  ['ParserAckNotice', 'ParserAckNoticeOpening', 'NoticeOnActiveOnly'],
  ['ParserAckNotice', 'ParserAckNoticeGraceful', 'NoticeOnActiveOnly'],
  ['ParserAckNotice', 'ParserAckNoticeClose', 'ReportBeforeLocalClose'],
  ['BrowserAckOrder', 'BrowserAckOrder'],
  ['BrowserAckOrder', 'BrowserAckOrderDrop', 'AcceptedPrefixReports'],
  ['BrowserAckOrder', 'BrowserAckOrderReplace', 'RefusalKeepsFirstCause'],
  ['BrowserAckOrder', 'BrowserAckOrderGenericDrop', 'GenericPrefixRetained'],
  ['BrowserAckOrder', 'BrowserAckOrderGenericNotice', 'GenericDoesNotReport'],
  ['DiagnosticRetirement', 'DiagnosticRetirement'],
  ['DiagnosticRetirement', 'DiagnosticRetirementThrow', 'ObserverFailureIsolated'],
  ['DiagnosticRetirement', 'DiagnosticRetirementHandoff', 'RetirementFencesHandoff'],
  ['PacketDiagnostics', 'PacketDiagnostics'],
  ['PacketDiagnostics', 'PacketDiagnosticsFinally', 'ReportOnlyAfterReturn'],
  ['TcpTlsHandshake', 'TcpTlsHandshake'],
  ['TcpTlsHandshake', 'TcpTlsHandshakeEarly', 'MqttRequiresAuthentication'],
  ['TcpTlsHandshake', 'TcpTlsHandshakeReplace', 'FirstFailureWins'],
  ['TcpTlsHandshake', 'TcpTlsHandshakeLeak', 'SettledFailureReleasesResources'],
];

const java = process.env['JAVA'] ?? 'java';
const modelDirectory = fileURLToPath(new URL('./', import.meta.url));

// A module or a configuration without a row would never run, and nothing else would report it.
const listed = new Set(models.flatMap(([model, configuration]) => [model + '.tla', configuration + '.cfg']));
assert.deepEqual(
  readdirSync(modelDirectory).filter((name) => /\.(?:tla|cfg)$/u.test(name) && !listed.has(name)),
  [],
  'Every .tla and .cfg file needs a row in models',
);

async function runTlc(model: string, configuration: string): Promise<Readonly<{ status: number | null; output: string }>> {
  const metadataDirectory = mkdtempSync(join(tmpdir(), 'mqtt-tlc-'));
  try {
    return await new Promise((settle, reject) => {
      const child = spawn(
        java,
        [
          // Most models have under 1,000 states, so JVM start dominates a case. The serial collector and the first
          // compiler tier start fewer threads per process. On four cores a run of all cases took 137 to 144 s without
          // them and 56 to 97 s with them.
          '-XX:+UseSerialGC',
          '-XX:TieredStopAtLevel=1',
          // A JVM that runs out of memory can hang. With this flag it exits with status 3, which fails the case.
          '-XX:+ExitOnOutOfMemoryError',
          // TLC unpacks its standard modules into the Java temporary directory. Two processes that share it fail to parse.
          '-Djava.io.tmpdir=' + metadataDirectory,
          '-cp',
          jarPath,
          'tlc2.TLC',
          '-workers',
          '1',
          '-metadir',
          metadataDirectory,
          '-config',
          configuration + '.cfg',
          model + '.tla',
        ],
        { cwd: modelDirectory, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      const collect = (chunk: string) => {
        output += chunk;
      };
      child.stdout.setEncoding('utf8').on('data', collect);
      child.stderr.setEncoding('utf8').on('data', collect);
      child.on('error', reject);
      child.on('close', (status) => {
        settle({ status, output });
      });
    });
  } finally {
    rmSync(metadataDirectory, { recursive: true, force: true });
  }
}

async function check([model, configuration, expectedInvariant]: VerificationCase): Promise<string> {
  const { status, output } = await runTlc(model, configuration);
  if (expectedInvariant !== undefined) {
    assert.notEqual(status, 0, output);
    assert.match(output, new RegExp('Invariant ' + expectedInvariant + ' is violated'), output);
    return configuration + ' caught ' + expectedInvariant;
  }
  assert.equal(status, 0, output);
  assert.match(output, /No error has been found/, output);
  // A progress line of a long run also says "distinct states found", with thousands separators. Read the final line.
  const states = /(\d+ distinct states found), 0 states left on queue/.exec(output)?.[1];
  assert.ok(states !== undefined, output);
  return configuration + ' ' + states;
}

// Each case is one single-worker TLC process with its own metadata and temporary directory, so the cases share no
// state and run side by side. The lines print in table order.
const jobs = Number(process.env['TLC_JOBS'] ?? availableParallelism());
assert.ok(Number.isInteger(jobs) && jobs > 0, 'TLC_JOBS must be a positive integer');
const lines: string[] = [];
let next = 0;
let printed = 0;
let failed = false;

async function worker(): Promise<void> {
  while (!failed) {
    const index = next++;
    const verificationCase = models[index];
    if (verificationCase === undefined) return;
    try {
      lines[index] = await check(verificationCase);
    } catch (error) {
      failed = true;
      throw error;
    }
    for (let line = lines[printed]; line !== undefined; line = lines[++printed]) console.log(line);
  }
}

// A failed case stops new cases. The cases already running finish first, so each removes its directory.
const outcomes = await Promise.allSettled(Array.from({ length: jobs }, worker));
for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
assert.equal(printed, models.length, 'Every case must report a result');
