import { AwaitQueue } from 'awaitqueue';
import { Logger } from './Logger';
import { EnhancedEventEmitter } from './enhancedEvents';
import { UnsupportedError, InvalidStateError } from './errors';
import * as utils from './utils';
import * as ortc from './ortc';
import {
	HandlerFactory,
	HandlerInterface,
	HandlerReceiveOptions,
} from './handlers/HandlerInterface';
import { Producer, ProducerOptions } from './Producer';
import { Consumer, ConsumerOptions } from './Consumer';
import { DataProducer, DataProducerOptions } from './DataProducer';
import { DataConsumer, DataConsumerOptions } from './DataConsumer';
import { RtpParameters, MediaKind } from './RtpParameters';
import { SctpParameters, SctpStreamParameters } from './SctpParameters';
import { AppData } from './types';

const logger = new Logger('Transport');

export type TransportOptions<TransportAppData extends AppData = AppData> = {
	id: string;
	iceParameters: IceParameters;
	iceCandidates: IceCandidate[];
	dtlsParameters: DtlsParameters;
	sctpParameters?: SctpParameters;
	iceServers?: RTCIceServer[];
	iceTransportPolicy?: RTCIceTransportPolicy;
	additionalSettings?: any;
	proprietaryConstraints?: any;
	appData?: TransportAppData;
};

export type CanProduceByKind = {
	audio: boolean;
	video: boolean;
	[key: string]: boolean;
};

export type IceParameters = {
	/**
	 * ICE username fragment.
	 * */
	usernameFragment: string;
	/**
	 * ICE password.
	 */
	password: string;
	/**
	 * ICE Lite.
	 */
	iceLite?: boolean;
};

export type IceCandidate = {
	/**
	 * Unique identifier that allows ICE to correlate candidates that appear on
	 * multiple transports.
	 */
	foundation: string;
	/**
	 * The assigned priority of the candidate.
	 */
	priority: number;
	/**
	 * The IP address or hostname of the candidate.
	 */
	address: string;
	/**
	 * The IP address  or hostname of the candidate.
	 * @deprecated Use |address| instead.
	 */
	ip: string;
	/**
	 * The protocol of the candidate.
	 */
	protocol: 'udp' | 'tcp';
	/**
	 * The port for the candidate.
	 */
	port: number;
	/**
	 * The type of candidate.
	 */
	type: 'host' | 'srflx' | 'prflx' | 'relay';
	/**
	 * The type of TCP candidate.
	 */
	tcpType?: 'active' | 'passive' | 'so';
};

export type DtlsParameters = {
	/**
	 * Server DTLS role. Default 'auto'.
	 */
	role?: DtlsRole;
	/**
	 * Server DTLS fingerprints.
	 */
	fingerprints: DtlsFingerprint[];
};

/**
 * The hash function algorithm (as defined in the "Hash function Textual Names"
 * registry initially specified in RFC 4572 Section 8).
 */
export type FingerprintAlgorithm =
	| 'sha-1'
	| 'sha-224'
	| 'sha-256'
	| 'sha-384'
	| 'sha-512';

/**
 * The hash function algorithm (as defined in the "Hash function Textual Names"
 * registry initially specified in RFC 4572 Section 8) and its corresponding
 * certificate fingerprint value (in lowercase hex string as expressed utilizing
 * the syntax of "fingerprint" in RFC 4572 Section 5).
 */
export type DtlsFingerprint = {
	algorithm: FingerprintAlgorithm;
	value: string;
};

export type DtlsRole = 'auto' | 'client' | 'server';

export type IceGatheringState = 'new' | 'gathering' | 'complete';

export type ConnectionState =
	| 'new'
	| 'connecting'
	| 'connected'
	| 'failed'
	| 'disconnected'
	| 'closed';

export type PlainRtpParameters = {
	ip: string;
	ipVersion: 4 | 6;
	port: number;
};

export type TransportEvents = {
	icegatheringstatechange: [IceGatheringState];	
	connectionstatechange: [ConnectionState];
};

export type TransportObserver = EnhancedEventEmitter<TransportObserverEvents>;

export type TransportObserverEvents = {
	close: [];
};


export class Transport<
	TransportAppData extends AppData = AppData
> extends EnhancedEventEmitter<TransportEvents> {
	// Id.
	private readonly _id: string;
	// Closed flag.
	protected _closed = false;
	// Direction.
	protected readonly _direction: 'send' | 'recv';
	// Extended RTP capabilities.
	protected readonly _extendedRtpCapabilities: any;
	// Whether we can produce audio/video based on computed extended RTP
	// capabilities.
	protected readonly _canProduceByKind: CanProduceByKind;
	// SCTP max message size if enabled, null otherwise.
	protected readonly _maxSctpMessageSize?: number | null;
	// RTC handler isntance.
	protected readonly _handler: HandlerInterface;
	// Transport ICE gathering state.
	private _iceGatheringState: IceGatheringState = 'new';
	// Transport connection state.
	private _connectionState: ConnectionState = 'new';
    // App custom data.
    private _appData: TransportAppData;

	// AwaitQueue instance to make async tasks happen sequentially.
	protected readonly _awaitQueue = new AwaitQueue();

	// Observer instance.
	protected readonly _observer: TransportObserver =
		new EnhancedEventEmitter<TransportObserverEvents>();

	private _certificate: RTCCertificate|undefined;

	private _runPromise: Promise<void>;

	constructor({
		direction,
		id,
		iceParameters,
		iceCandidates,
		dtlsParameters,
		sctpParameters,
		iceServers,
		iceTransportPolicy,
		additionalSettings,
		proprietaryConstraints,
		appData,
		handlerFactory,
		extendedRtpCapabilities,
		canProduceByKind
	}: {
			direction: 'send' | 'recv';
			handlerFactory: HandlerFactory;
			extendedRtpCapabilities: any;
			canProduceByKind: CanProduceByKind;
	} & TransportOptions<TransportAppData>)	{
		super();

		logger.debug('constructor() [id:%s, direction:%s]', id, direction);

		this._id = id;
		this._direction = direction;
		this._extendedRtpCapabilities = extendedRtpCapabilities;
		this._canProduceByKind = canProduceByKind;
		this._maxSctpMessageSize = sctpParameters
			? sctpParameters.maxMessageSize
			: null;

		// Clone and sanitize additionalSettings.
		const clonedAdditionalSettings = utils.clone(additionalSettings) ?? {};

		delete clonedAdditionalSettings.iceServers;
		delete clonedAdditionalSettings.iceTransportPolicy;
		delete clonedAdditionalSettings.bundlePolicy;
		delete clonedAdditionalSettings.rtcpMuxPolicy;
		delete clonedAdditionalSettings.sdpSemantics;

		this._handler = handlerFactory();

		this.handleHandler();

        this._appData = appData || {} as TransportAppData;
		const stdECDSACertificate = {
            name: "ECDSA",
            namedCurve: "P-256",
        };
        
		this._runPromise = RTCPeerConnection.generateCertificate(stdECDSACertificate)
            .then((certificate) => {
                this._certificate = certificate;
                clonedAdditionalSettings.certificates = [certificate];
                this._handler.run(
                    {
                        direction,
                        iceParameters,
                        iceCandidates,
                        dtlsParameters,
                        sctpParameters,
                        iceServers,
                        iceTransportPolicy,
                        additionalSettings: clonedAdditionalSettings,
                        proprietaryConstraints,
                        extendedRtpCapabilities
                    });
				logger.debug("generate certificate success");
            });
	}

	async run() {
		return this._runPromise;
	}
	
    get fingerprints(): RTCDtlsFingerprint[] {
        const fingerprints = this._certificate!.getFingerprints();
		return fingerprints.map((f) => {
			return {   
				algorithm: f.algorithm,
				value: f.value?.toUpperCase(),
			}
		});
    }

	/**
	 * Transport id.
	 */
	get id(): string {
		return this._id;
	}

	/**
	 * Whether the Transport is closed.
	 */
	get closed(): boolean {
		return this._closed;
	}

	/**
	 * Transport direction.
	 */
	get direction(): 'send' | 'recv' {
		return this._direction;
	}

	/**
	 * RTC handler instance.
	 */
	get handler(): HandlerInterface {
		return this._handler;
	}

	/**
	 * ICE gathering state.
	 */
	get iceGatheringState(): IceGatheringState {
		return this._iceGatheringState;
	}

	/**
	 * Connection state.
	 */
	get connectionState(): ConnectionState {
		return this._connectionState;
	}

	/**
	 * App custom data.
	 */
	get appData(): TransportAppData {
		return this._appData;
	}

	/**
	 * App custom data setter.
	 */
	set appData(appData: TransportAppData) {
		this._appData = appData;
	}

	get observer(): TransportObserver {
		return this._observer;
	}

	/**
	 * Close the Transport.
	 */
	close(): void {
		if (this._closed) {
			return;
		}

		logger.debug('close()');

		this._closed = true;

		// Stop the AwaitQueue.
		this._awaitQueue.stop();

		// Close the handler.
		this._handler.close();

		// Change connection state to 'closed' since the handler may not emit
		// '@connectionstatechange' event.
		this._connectionState = 'closed';

		// Emit observer event.
		this._observer.safeEmit('close');
	}

	/**
	 * Get associated Transport (RTCPeerConnection) stats.
	 *
	 * @returns {RTCStatsReport}
	 */
	async getStats(): Promise<RTCStatsReport> {
		if (this._closed) {
			throw new InvalidStateError('closed');
		}

		return this._handler.getTransportStats();
	}

	/**
	 * Restart ICE connection.
	 */
	async restartIce({
		iceParameters,
	}: {
		iceParameters: IceParameters;
	}): Promise<void> {
		logger.debug('restartIce()');

		if (this._closed) {
			throw new InvalidStateError('closed');
		} else if (!iceParameters) {
			throw new TypeError('missing iceParameters');
		}

		// Enqueue command.
		return this._awaitQueue.push(
			async () => await this._handler.restartIce(iceParameters),
			'transport.restartIce()'
		);
	}

	/**
	 * Update ICE servers.
	 */
	async updateIceServers({
		iceServers,
	}: { iceServers?: RTCIceServer[] } = {}): Promise<void> {
		logger.debug('updateIceServers()');

		if (this._closed) {
			throw new InvalidStateError('closed');
		} else if (!Array.isArray(iceServers)) {
			throw new TypeError('missing iceServers');
		}

		// Enqueue command.
		return this._awaitQueue.push(
			async () => this._handler.updateIceServers(iceServers),
			'transport.updateIceServers()'
		);
	}

	private handleHandler(): void {
		const handler = this._handler;

		handler.on('@connect', (
			{ dtlsParameters }: { dtlsParameters: DtlsParameters },
			callback: () => void,
			errback: (error: Error) => void
		) =>
		{
			if (this._closed)
			{
				errback(new InvalidStateError('closed'));

				return;
			}

			callback();
		});

		handler.on(
			'@icegatheringstatechange',
			(iceGatheringState: IceGatheringState) => {
				if (iceGatheringState === this._iceGatheringState) {
					return;
				}

				logger.debug('ICE gathering state changed to %s', iceGatheringState);

				this._iceGatheringState = iceGatheringState;

				if (!this._closed) {
					this.safeEmit('icegatheringstatechange', iceGatheringState);
				}
			}
		);

		handler.on('@connectionstatechange', (connectionState: ConnectionState) => {
			if (connectionState === this._connectionState) {
				return;
			}

			logger.debug('connection state changed to %s', connectionState);

			this._connectionState = connectionState;

			if (!this._closed) {
				this.safeEmit('connectionstatechange', connectionState);
			}
		});
	}

}
