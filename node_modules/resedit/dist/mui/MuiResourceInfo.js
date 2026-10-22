import { allocatePartialBinary, copyBuffer, readUint16WithLastOffset, readUint32WithLastOffset, roundUp, } from '../util/functions.js';
function isValidMuiResourceEntry(resourceEntry) {
    var view = new DataView(resourceEntry.bin);
    if (view.getUint32(0, true) !== 0xfecdfecd) {
        return false;
    }
    var len = view.getUint32(4, true);
    if (len !== resourceEntry.bin.byteLength) {
        return false;
    }
    var version = view.getUint32(8, true);
    // Currently only 0x00010000 is supported
    if (version !== 0x00010000) {
        return false;
    }
    var fileType = view.getUint32(16, true);
    // The lower 4-bit is the role type (neutral: 1 or specific: 2)
    if ((fileType & 0x0f) !== 1 && (fileType & 0x0f) !== 2) {
        return false;
    }
    return true;
}
function parseMuiResourceData(resourceEntry) {
    var view = new DataView(resourceEntry.bin);
    var len = view.getUint32(4, true);
    var fileTypeNum = readUint32WithLastOffset(view, 16, len) & 0xf0;
    var fileType = fileTypeNum === 0x10 ? 'system' : 'application';
    var isLn = (fileTypeNum & 0x0f) !== 2;
    var systemAttributes = readUint32WithLastOffset(view, 20, len);
    var ultimateFallbackLocationNum = readUint32WithLastOffset(view, 24, len);
    var ultimateFallbackLocation = ultimateFallbackLocationNum === 2 ? 'external' : 'internal';
    var checksumMain = new Uint8Array(allocatePartialBinary(resourceEntry.bin, 28, 16));
    var checksumService = new Uint8Array(allocatePartialBinary(resourceEntry.bin, 44, 16));
    var mainNameTypesOffset = readUint32WithLastOffset(view, 84, len);
    var mainNameTypesLength = readUint32WithLastOffset(view, 88, len);
    var mainIDTypesOffset = readUint32WithLastOffset(view, 92, len);
    var mainIDTypesLength = readUint32WithLastOffset(view, 96, len);
    var muiNameTypesOffset = readUint32WithLastOffset(view, 100, len);
    var muiNameTypesLength = readUint32WithLastOffset(view, 104, len);
    var muiIDTypesOffset = readUint32WithLastOffset(view, 108, len);
    var muiIDTypesLength = readUint32WithLastOffset(view, 112, len);
    var languageOffset = readUint32WithLastOffset(view, 116, len);
    var languageLength = readUint32WithLastOffset(view, 120, len);
    var ultimateFallbackLanguageOffset = readUint32WithLastOffset(view, 124, len);
    var ultimateFallbackLanguageLength = readUint32WithLastOffset(view, 128, len);
    var o;
    var e;
    var s = '';
    var mainTypes = [];
    for (o = mainNameTypesOffset, e = mainNameTypesOffset + mainNameTypesLength; o < e; o += 2) {
        var char = readUint16WithLastOffset(view, o, len);
        if (char === 0) {
            if (o > mainNameTypesOffset && s === '') {
                break;
            }
            mainTypes.push(s);
            s = '';
        }
        else {
            s += String.fromCharCode(char);
        }
    }
    if (s !== '') {
        mainTypes.push(s);
    }
    for (o = mainIDTypesOffset, e = mainIDTypesOffset + mainIDTypesLength; o < e; o += 4) {
        var t = readUint32WithLastOffset(view, o, len);
        if (t > 0) {
            mainTypes.push(t);
        }
    }
    var muiTypes = [];
    for (s = '',
        o = muiNameTypesOffset,
        e = muiNameTypesOffset + muiNameTypesLength; o < e; o += 2) {
        var char = readUint16WithLastOffset(view, o, len);
        if (char === 0) {
            if (o > muiNameTypesOffset && s === '') {
                break;
            }
            muiTypes.push(s);
            s = '';
        }
        else {
            s += String.fromCharCode(char);
        }
    }
    if (s !== '') {
        muiTypes.push(s);
    }
    for (o = muiIDTypesOffset, e = muiIDTypesOffset + muiIDTypesLength; o < e; o += 4) {
        var t = readUint32WithLastOffset(view, o, len);
        if (t > 0) {
            muiTypes.push(t);
        }
    }
    for (s = '', o = languageOffset, e = languageOffset + languageLength; o < e; o += 2) {
        var char = readUint16WithLastOffset(view, o, len);
        if (char === 0) {
            break;
        }
        s += String.fromCharCode(char);
    }
    var language = s;
    for (s = '',
        o = ultimateFallbackLanguageOffset,
        e = ultimateFallbackLanguageOffset + ultimateFallbackLanguageLength; o < e; o += 2) {
        var char = readUint16WithLastOffset(view, o, len);
        if (char === 0) {
            break;
        }
        s += String.fromCharCode(char);
    }
    var ultimateFallbackLanguage = s;
    return {
        resLang: resourceEntry.lang,
        isLn: isLn,
        fileType: fileType,
        systemAttributes: systemAttributes,
        checksumMain: checksumMain,
        checksumService: checksumService,
        language: language,
        ultimateFallbackLanguage: ultimateFallbackLanguage,
        ultimateFallbackLocation: ultimateFallbackLocation,
        mainTypes: mainTypes,
        muiTypes: muiTypes,
    };
}
function generateMuiResourceData(data) {
    var binaryLength = 136; // 132 + padding for 8-byte alignment
    var mainNameTypesOffset = 0;
    var mainNameTypesLength = 0;
    var mainIDTypesOffset = 0;
    var mainIDTypesLength = 0;
    var muiNameTypesOffset = 0;
    var muiNameTypesLength = 0;
    var muiIDTypesOffset = 0;
    var muiIDTypesLength = 0;
    var languageOffset = 0;
    var languageLength = 0;
    var ultimateFallbackLanguageOffset = 0;
    var ultimateFallbackLanguageLength = 0;
    data.mainTypes.forEach(function (type) {
        if (typeof type === 'number') {
            mainIDTypesLength += 4;
        }
        else {
            mainNameTypesLength += (type.length + 1) * 2;
        }
    });
    if (mainNameTypesLength > 0) {
        mainNameTypesLength += 6; // last null char and two extra null chars
    }
    data.muiTypes.forEach(function (type) {
        if (typeof type === 'number') {
            muiIDTypesLength += 4;
        }
        else {
            muiNameTypesLength += (type.length + 1) * 2;
        }
    });
    if (muiNameTypesLength > 0) {
        muiNameTypesLength += 6; // last null char and two extra null chars
    }
    if (data.isLn) {
        if (data.ultimateFallbackLocation === 'external') {
            ultimateFallbackLanguageLength =
                (data.ultimateFallbackLanguage.length + 1) * 2;
        }
    }
    else {
        languageLength = (data.language.length + 1) * 2;
    }
    if (mainNameTypesLength > 0) {
        mainNameTypesOffset = binaryLength;
        binaryLength += roundUp(mainNameTypesLength, 8);
    }
    if (mainIDTypesLength > 0) {
        mainIDTypesOffset = binaryLength;
        binaryLength += roundUp(mainIDTypesLength, 8);
    }
    if (muiNameTypesLength > 0) {
        muiNameTypesOffset = binaryLength;
        binaryLength += roundUp(muiNameTypesLength, 8);
    }
    if (muiIDTypesLength > 0) {
        muiIDTypesOffset = binaryLength;
        binaryLength += roundUp(muiIDTypesLength, 8);
    }
    if (languageLength > 0) {
        languageOffset = binaryLength;
        binaryLength += roundUp(languageLength, 8);
    }
    if (ultimateFallbackLanguageLength > 0) {
        ultimateFallbackLanguageOffset = binaryLength;
        binaryLength += roundUp(ultimateFallbackLanguageLength, 8);
    }
    var bin = new ArrayBuffer(binaryLength);
    var view = new DataView(bin);
    view.setUint32(0, 0xfecdfecd, true);
    view.setUint32(4, binaryLength, true);
    view.setUint32(8, 0x00010000, true);
    view.setUint32(16, ((data.fileType === 'system' ? 1 : 2) << 4) + (data.isLn ? 1 : 2), true);
    view.setUint32(20, data.systemAttributes, true);
    view.setUint32(24, data.isLn ? (data.ultimateFallbackLocation === 'internal' ? 1 : 2) : 0, true);
    copyBuffer(bin, 28, data.checksumMain, 0, data.checksumMain.length < 16 ? data.checksumMain.length : 16);
    copyBuffer(bin, 44, data.checksumService, 0, data.checksumService.length < 16 ? data.checksumService.length : 16);
    view.setUint32(84, mainNameTypesOffset, true);
    view.setUint32(88, mainNameTypesLength, true);
    view.setUint32(92, mainIDTypesOffset, true);
    view.setUint32(96, mainIDTypesLength, true);
    view.setUint32(100, muiNameTypesOffset, true);
    view.setUint32(104, muiNameTypesLength, true);
    view.setUint32(108, muiIDTypesOffset, true);
    view.setUint32(112, muiIDTypesLength, true);
    view.setUint32(116, languageOffset, true);
    view.setUint32(120, languageLength, true);
    view.setUint32(124, ultimateFallbackLanguageOffset, true);
    view.setUint32(128, ultimateFallbackLanguageLength, true);
    var offset = 136;
    if (mainNameTypesLength > 0) {
        data.mainTypes.forEach(function (type) {
            if (typeof type !== 'number') {
                for (var i = 0; i < type.length; ++i) {
                    view.setUint16(offset, type.charCodeAt(i), true);
                    offset += 2;
                }
                offset += 2;
            }
        });
        offset += 6; // last null char and two extra null chars
        offset = roundUp(offset, 8);
    }
    if (mainIDTypesLength > 0) {
        data.mainTypes.forEach(function (type) {
            if (typeof type === 'number') {
                view.setUint32(offset, type, true);
                offset += 4;
            }
        });
        offset = roundUp(offset, 8);
    }
    if (muiNameTypesLength > 0) {
        data.muiTypes.forEach(function (type) {
            if (typeof type !== 'number') {
                for (var i = 0; i < type.length; ++i) {
                    view.setUint16(offset, type.charCodeAt(i), true);
                    offset += 2;
                }
                offset += 2;
            }
        });
        offset += 6; // last null char and two extra null chars
        offset = roundUp(offset, 8);
    }
    if (muiIDTypesLength > 0) {
        data.muiTypes.forEach(function (type) {
            if (typeof type === 'number') {
                view.setUint32(offset, type, true);
                offset += 4;
            }
        });
        offset = roundUp(offset, 8);
    }
    if (languageLength > 0) {
        for (var i = 0; i < data.language.length; ++i) {
            view.setUint16(offset, data.language.charCodeAt(i), true);
            offset += 2;
        }
        offset += 2;
        offset = roundUp(offset, 8);
    }
    if (ultimateFallbackLanguageLength > 0) {
        for (var i = 0; i < data.ultimateFallbackLanguage.length; ++i) {
            view.setUint16(offset, data.ultimateFallbackLanguage.charCodeAt(i), true);
            offset += 2;
        }
        offset += 2;
        offset = roundUp(offset, 8);
    }
    return {
        type: 'MUI',
        id: 1,
        lang: data.resLang,
        codepage: 1200,
        bin: bin,
    };
}
var MuiResourceInfo = /** @class */ (function () {
    function MuiResourceInfo(_data) {
        this.data = _data;
    }
    /**
     * Parses an executable with resource.
     * @param executableResource `NtExecutableResource` instance for the LN or MUI executable (retrieved/created via `NtExecutableResource.from`)
     * @returns `MuiResourceInfo` instance to treat the MUI resource
     */
    MuiResourceInfo.from = function (executableResource) {
        var muiResourceData = null;
        try {
            executableResource.entries.forEach(function (entry) {
                if (muiResourceData != null) {
                    return;
                }
                if (entry.type === 'MUI' && isValidMuiResourceEntry(entry)) {
                    muiResourceData = parseMuiResourceData(entry);
                }
            });
        }
        catch (_a) {
            // ignore if resource is not found
        }
        return new MuiResourceInfo(muiResourceData);
    };
    /**
     * Creates the new `MuiResourceInfo` instance with empty data.
     * This is useful for creating MUI resource data by scratch.
     */
    MuiResourceInfo.createEmpty = function () {
        return new MuiResourceInfo(null);
    };
    /**
     * Generates resource data from current data.
     * Non-null returned values can be stored to `NtExecutableResource.entries`.
     */
    MuiResourceInfo.prototype.generateEntry = function () {
        return this.data == null ? null : generateMuiResourceData(this.data);
    };
    /**
     * Replace an MUI entry for `NtExecutableResource` with containing resource data (generated by {@linkcode generateEntry}).
     * All MUI entries are replaced; if `generateEntry` returns null entry, or the resource data for specified MUI executable is not found,
     * MUI entries for the executable will be removed.
     * @param targetExecutableResource `NtExecutableResource` instance
     */
    MuiResourceInfo.prototype.replaceMuiEntryForExecutables = function (targetExecutableResource) {
        var generated = this.generateEntry();
        {
            var found = false;
            for (var i = targetExecutableResource.entries.length - 1; i >= 0; --i) {
                var entry = targetExecutableResource.entries[i];
                if (entry.type === 'MUI') {
                    // Remove duplicate resources if already found
                    if (found || generated == null) {
                        targetExecutableResource.entries.splice(i, 1);
                    }
                    else {
                        targetExecutableResource.entries[i] = generated;
                    }
                    found = true;
                }
            }
            if (!found && generated != null) {
                targetExecutableResource.entries.unshift(generated);
            }
        }
    };
    return MuiResourceInfo;
}());
export default MuiResourceInfo;
