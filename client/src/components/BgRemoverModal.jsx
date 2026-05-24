import React, { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../lib/api';

const BgRemoverModal = ({ isOpen, onClose, authToken }) => {
    const [inputImage, setInputImage] = useState('');
    const [resultImage, setResultImage] = useState('');
    const [isRemoving, setIsRemoving] = useState(false);
    const [error, setError] = useState('');
    const [provider, setProvider] = useState('third_party');
    const fileInputRef = useRef(null);

    useEffect(() => {
        if (!isOpen) {
            setInputImage('');
            setResultImage('');
            setIsRemoving(false);
            setError('');
            setProvider('third_party');
        }
    }, [isOpen]);

    const handleFileChange = (event) => {
        const file = event.target.files?.[0];
        if (!file || !file.type.startsWith('image/')) {
            return;
        }
        const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
        if (!allowedTypes.has(file.type)) {
            setError('Unsupported format. Please upload PNG, JPG, or WebP.');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === 'string') {
                const rawDataUrl = reader.result;
                const img = new Image();
                img.onload = () => {
                    try {
                        const canvas = document.createElement('canvas');
                        const rawWidth = img.naturalWidth || img.width;
                        const rawHeight = img.naturalHeight || img.height;
                        const maxSide = 1400;
                        const scale = Math.min(1, maxSide / Math.max(rawWidth, rawHeight));
                        canvas.width = Math.max(1, Math.round(rawWidth * scale));
                        canvas.height = Math.max(1, Math.round(rawHeight * scale));
                        const ctx = canvas.getContext('2d');
                        if (!ctx) {
                            throw new Error('Canvas not supported');
                        }
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                        const pngDataUrl = canvas.toDataURL('image/png');
                        setInputImage(pngDataUrl);
                    } catch (err) {
                        setInputImage(rawDataUrl);
                    } finally {
                        setResultImage('');
                        setError('');
                    }
                };
                img.onerror = () => {
                    setInputImage(rawDataUrl);
                    setResultImage('');
                    setError('');
                };
                img.src = rawDataUrl;
            }
        };
        reader.readAsDataURL(file);
    };

    const handleRemoveBackground = async () => {
        if (!inputImage || isRemoving) {
            return;
        }

        setIsRemoving(true);
        setError('');

        try {
            const response = await fetch(apiUrl('/api/remove-background'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
                },
                body: JSON.stringify({ imageData: inputImage, provider }),
            });

            if (!response.ok) {
                const errorPayload = await response.json().catch(() => ({}));
                const message = errorPayload?.details || errorPayload?.error || 'Background removal failed';
                throw new Error(message);
            }

            const data = await response.json();
            setResultImage(data?.imageUrl || '');
        } catch (err) {
            setError(err?.message || 'Background removal failed');
        } finally {
            setIsRemoving(false);
        }
    };

    if (!isOpen) {
        return null;
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} />
            <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-2xl mx-4">
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
                    <h3 className="text-lg font-semibold text-slate-900">Background Remover</h3>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-slate-400 hover:text-slate-700 text-xl leading-none"
                    >
                        ×
                    </button>
                </div>

                <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="md:col-span-2">
                        <p className="text-xs uppercase tracking-wide text-slate-400 mb-2">Provider</p>
                        <div className="flex flex-wrap gap-3">
                            <button
                                type="button"
                                onClick={() => setProvider('third_party')}
                                className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
                                    provider === 'third_party'
                                        ? 'bg-slate-900 text-white border-slate-900'
                                        : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                                }`}
                            >
                                Use 3rd Party API
                            </button>
                            <button
                                type="button"
                                onClick={() => setProvider('gemini')}
                                className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition ${
                                    provider === 'gemini'
                                        ? 'bg-slate-900 text-white border-slate-900'
                                        : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                                }`}
                            >
                                Use Gemini
                            </button>
                        </div>
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400 mb-2">Original</p>
                        <div className="border border-dashed border-slate-300 rounded-xl p-4 min-h-[200px] flex flex-col items-center justify-center text-slate-400 bg-slate-50">
                            {inputImage ? (
                                <img src={inputImage} alt="Original upload" className="max-h-56 object-contain" />
                            ) : (
                                <p className="text-sm">Upload an image</p>
                            )}
                        </div>
                        <div className="mt-4 flex items-center gap-3">
                            <button
                                type="button"
                                className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-300 text-slate-700 bg-white hover:border-slate-400 hover:bg-slate-50 transition"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isRemoving}
                            >
                                Upload Image
                            </button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                className="hidden"
                                onChange={handleFileChange}
                            />
                        </div>
                    </div>

                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400 mb-2">Result (PNG)</p>
                        <div className="border border-dashed border-slate-300 rounded-xl p-4 min-h-[200px] flex flex-col items-center justify-center text-slate-400 bg-slate-50">
                            {resultImage ? (
                                <img src={resultImage} alt="Background removed" className="max-h-56 object-contain" />
                            ) : (
                                <p className="text-sm">No result yet</p>
                            )}
                        </div>
                        <div className="mt-4 flex items-center gap-3">
                            <button
                                type="button"
                                className="text-xs font-semibold px-3 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800 transition disabled:opacity-60"
                                onClick={handleRemoveBackground}
                                disabled={!inputImage || isRemoving}
                            >
                                {isRemoving ? 'Removing...' : 'Remove Background'}
                            </button>
                            {resultImage && (
                                <a
                                    href={resultImage}
                                    download="bg-removed.png"
                                    className="text-xs font-semibold px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:border-slate-400 hover:bg-slate-50 transition"
                                >
                                    Download PNG
                                </a>
                            )}
                        </div>
                    </div>
                </div>

                {error && (
                    <div className="px-6 pb-6">
                        <p className="text-sm text-red-500">{error}</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default BgRemoverModal;
