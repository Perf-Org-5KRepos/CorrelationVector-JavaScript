/**
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License.
 */

import { CorrelationVectorVersion } from "./CorrelationVectorversion";
import { SpinCounterInterval, SpinCounterPeriodicity, SpinEntropy, SpinParameters } from "./spinParameters";

/**
 * This class represents a lightweight vector for identifying and measuring
 * causality.
 */
export class CorrelationVector {
    private static readonly maxVectorLength: number = 63;
    private static readonly maxVectorLengthV2: number = 127;
    private static readonly baseLength: number = 16;
    private static readonly baseLengthV2: number = 22;
    private static readonly base64CharSet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    private baseVector: string = null;

    private extension: number = 0;

    private immutable: boolean = false;

    /**
     * This is the header that should be used between services to pass the correlation
     * vector.
     */
    public static readonly headerName: string = "MS-CV";

    /**
     * This is termination sign should be used when vector lenght exceeds
     * max allowed length
     */
    public static readonly terminationSign: string = "!";

    /**
     * Gets or sets a value indicating whether or not to validate the correlation
     * vector on creation.
     */
    public static validateCorrelationVectorDuringCreation: boolean;

    /**
     * Creates a new correlation vector by extending an existing value. This should be
     * done at the entry point of an operation.
     * @param {string} correlationVector taken from the message header indicated by {@link CorrelationVector#headerName}
     * @returns {CorrelationVector} A new correlation vector extended from the current vector.
     */
    public static extend(correlationVector: string): CorrelationVector {
        if (CorrelationVector.isImmutable(correlationVector)) {
            return CorrelationVector.parse(correlationVector);
        }

        let version: CorrelationVectorVersion = CorrelationVector.inferversion(
            correlationVector, CorrelationVector.validateCorrelationVectorDuringCreation);

        if (CorrelationVector.validateCorrelationVectorDuringCreation) {
            CorrelationVector.validate(correlationVector, version);
        }

        if (CorrelationVector.isOversized(correlationVector, 0, version)) {
            return CorrelationVector.parse(correlationVector + CorrelationVector.terminationSign);
        }

        return new CorrelationVector(correlationVector, 0, version, false);
    }

    /**
     * Creates a new correlation vector by applying the Spin operator to an existing value.
     * this should be done at the entry point of an operation.
     * @param {string} correlationVector taken from the message header indicated by {@link CorrelationVector#headerName}
     * @param {SpinParameters} parameters the parameters to use when applying the Spin operator.
     * @returns {CorrelationVector} A new correlation vector spined from the current vector.
     */
    public static spin(correlationVector: string, parameters?: SpinParameters): CorrelationVector {
        if (CorrelationVector.isImmutable(correlationVector)) {
            return CorrelationVector.parse(correlationVector);
        }

        let version: CorrelationVectorVersion = CorrelationVector.inferversion(
            correlationVector, CorrelationVector.validateCorrelationVectorDuringCreation);

        if (CorrelationVector.validateCorrelationVectorDuringCreation) {
            CorrelationVector.validate(correlationVector, version);
        }

        parameters = parameters || new SpinParameters(
            SpinCounterInterval.Coarse,
            SpinCounterPeriodicity.Short,
            SpinEntropy.Two
        );

        let value: number = 0;

        // the Interval of change should be 1.67 seconds for Coarse
        // and 6.6 ms for fine
        // in JavaScript I am going to use 1.67 seconds, but 7 ms since
        // the Javascript clock stops at the millisecond.
        if (parameters.interval === SpinCounterInterval.Coarse) {
            value = Math.round(Date.now() / 1670);
        } else if (parameters.interval === SpinCounterInterval.Fine) {
            value = Math.round(Date.now() / 7);
        }

        if (parameters.entropy > 0) {
            let entropy: number = Math.round(Math.random() * Math.pow(2, ((parameters.entropy * 8) - 1)));

            // tslint:disable-next-line:no-bitwise
            value = (value << (parameters.entropy * 8)) | entropy;
        }

        // tslint:disable-next-line:no-bitwise
        let s: number = value & ((1 << parameters.totalBits) - 1);

        let baseVector: string = `${correlationVector}.${s}`;
        if (CorrelationVector.isOversized(baseVector, 0, version)) {
            return CorrelationVector.parse(correlationVector + CorrelationVector.terminationSign);
        }

        return new CorrelationVector(baseVector, 0, version, false);
    }

    /**
     * Creates a new correlation vector by parsing its string representation
     * @param {string} correlationVector correlationVector
     * @returns {CorrelationVector} parsed correlation vector
     */
    public static parse(correlationVector: string): CorrelationVector {
        if (correlationVector) {
            let p:number = correlationVector.lastIndexOf(".");
            let immutable:boolean = CorrelationVector.isImmutable(correlationVector);
            if (p > 0) {
                let extensionValue: string = immutable ?
                    correlationVector.substr(p + 1, correlationVector.length - p - 1 - CorrelationVector.terminationSign.length)
                    : correlationVector.substr(p + 1);
                let extension: number = parseInt(extensionValue, 10);
                if (!isNaN(extension) && extension >= 0) {
                    return new CorrelationVector(
                        correlationVector.substr(0, p),
                        extension,
                        CorrelationVector.inferversion(correlationVector, false),
                        immutable);
                }
            }
        }

        return CorrelationVector.createCorrelationVector();
    }

    /**
     * Initializes a new instance of the {@link CorrelationVector} class of the
     * given implemenation version. This should only be called when no correlation
     * vector was found in the message header.
     * @param {CorrelationVectorVersion} version The correlation vector implemenation version.
     * @returns {CorrelationVector} created correlation vector
     */
    public static createCorrelationVector(version?: CorrelationVectorVersion): CorrelationVector {
        version = version || CorrelationVectorVersion.V1;
        return new CorrelationVector(CorrelationVector.seedCorrelationVector(version), 0, version, false);
    }


    /**
     * Gets the value of the correlation vector as a string.
     */
    public get value(): string {
        return `${this.baseVector}.${this.extension}${this.immutable ? CorrelationVector.terminationSign : ""}`;
    }

    /**
     * Increments the current extension by one. Do this before passing the value to an
     * outbound message header.
     * @returns {string} the new value as a string that you can add to the outbound message header
     * indicated by {@link CorrelationVector#headerName}.
     */
    public increment(): string {
        if (this.immutable) {
            return this.value;
        }
        if (this.extension === Number.MAX_SAFE_INTEGER) {
            return this.value;
        }
        let next:number = this.extension + 1;
        if (CorrelationVector.isOversized(this.baseVector, next, this.version)) {
            this.immutable = true;
            return this.value;
        }
        this.extension = next;

        return `${this.baseVector}.${next}`;
    }

    /**
     * Gets the version of the correlation vector implementation.
     */
    public version: CorrelationVectorVersion;

    /**
     * Returns a string that represents the current object.
     * @returns {string} A string that represents the current object.
     */
    public toString(): string {
        return this.value;
    }

    private constructor(baseVector: string, extension: number, version: CorrelationVectorVersion, immutable: boolean) {
        this.baseVector = baseVector;
        this.extension = extension;
        this.version = version;
        this.immutable = immutable || CorrelationVector.isOversized(baseVector, extension, version);
    }

    /**
     * Seed function to randomly generate a 16 character base64 encoded string for the Correlation Vector's base value
     * @returns {string} Returns generated base value
     */
    private static seedCorrelationVector(version: CorrelationVectorVersion): string {
        let result:string = "";
        let baseLength: number = version === CorrelationVectorVersion.V1 ?
            CorrelationVector.baseLength :
            CorrelationVector.baseLengthV2;
        for (let i:number = 0; i < baseLength; i++) {
            result += CorrelationVector.base64CharSet.charAt(Math.floor(Math.random() * CorrelationVector.base64CharSet.length));
        }

        return result;
    }

    private static inferversion(correlationVector: string, reportErrors: boolean): CorrelationVectorVersion {
        let index: number = correlationVector == null ? -1 : correlationVector.indexOf(".");

        if (CorrelationVector.baseLength === index) {
            return CorrelationVectorVersion.V1;
        } else if (CorrelationVector.baseLengthV2 === index) {
            return CorrelationVectorVersion.V2;
        } else {
            // by default not reporting error, just return V1
            return CorrelationVectorVersion.V1;
        }
    }

    private static isImmutable(correlationVector: string): boolean {
        return correlationVector && correlationVector.endsWith(CorrelationVector.terminationSign);
    }

    private static isOversized(baseVector: string, extension: number, version: CorrelationVectorVersion): boolean {
        if (baseVector) {
            let size:number = baseVector.length + 1 +
                (extension > 0 ? Math.floor(Math.log10(extension)) : 0) + 1;
            return ((version === CorrelationVectorVersion.V1 &&
                size > CorrelationVector.maxVectorLength) ||
                (version === CorrelationVectorVersion.V2 &&
                    size > CorrelationVector.maxVectorLengthV2));
        }
        return false;
    }

    private static validate(correlationVector: string, version: CorrelationVectorVersion): void {
        let maxVectorLength: number;
        let baseLength: number;

        if (CorrelationVectorVersion.V1 === version) {
            maxVectorLength = CorrelationVector.maxVectorLength;
            baseLength = CorrelationVector.baseLength;
        } else if (CorrelationVectorVersion.V2 === version) {
            maxVectorLength = CorrelationVector.maxVectorLengthV2;
            baseLength = CorrelationVector.baseLengthV2;
        } else {
            throw new Error(`Unsupported correlation vector version: ${version}`);
        }

        if (!correlationVector || correlationVector.length > maxVectorLength) {
            throw new Error(
                `The ${version} correlation vector can not be null or bigger than ${maxVectorLength} characters`);
        }

        let parts: string[] = correlationVector.split(".");

        if (parts.length < 2 || parts[0].length !== baseLength) {
            throw new Error(`Invalid correlation vector ${correlationVector}. Invalid base value ${parts[0]}`);
        }

        for (let i: number = 1; i < parts.length; i++) {
            let result: number = parseInt(parts[i], 10);
            if (isNaN(result) || result < 0) {
                throw new Error(`Invalid correlation vector ${correlationVector}. Invalid extension value ${parts[i]}`);
            }
        }
    }
}