import React, { useRef, useState } from 'react';

const ImageUpload = ({
    imagePreview,
    onImageSelected,
    title = 'Click or drag image here',
    subtitle = 'Supports PNG, JPG, JPEG',
    replaceLabel = 'Replace Image',
    minHeightClass = 'min-h-[220px]',
}) => {
    const [dragActive, setDragActive] = useState(false);
    const inputRef = useRef(null);

    const handleDrag = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'dragenter' || e.type === 'dragover') {
            setDragActive(true);
        } else if (e.type === 'dragleave') {
            setDragActive(false);
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleFile(e.dataTransfer.files[0]);
        }
    };

    const handleChange = (e) => {
        e.preventDefault();
        if (e.target.files && e.target.files[0]) {
            handleFile(e.target.files[0]);
        }
    };

    const handleFile = (file) => {
        if (!file) return;
        if (!file.type.startsWith('image/')) return;

        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result;
            if (typeof dataUrl === 'string') {
                onImageSelected?.(dataUrl, file);
            }
        };
        reader.readAsDataURL(file);
    };

    return (
        <div className="w-full">
            <div
                className={`relative group cursor-pointer transition-all duration-300 overflow-hidden rounded-2xl border-2 border-dashed flex items-center justify-center ${minHeightClass} ${imagePreview ? 'border-slate-200/80 bg-white' : 'border-[#d0d7e2] hover:border-blue-400 bg-white'} ${dragActive ? 'border-blue-500 bg-blue-50/30' : ''}`}
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                onClick={() => inputRef.current?.click()}
            >
                <input
                    ref={inputRef}
                    type="file"
                    className="hidden"
                    onChange={handleChange}
                    accept="image/*"
                />

                {imagePreview ? (
                    <div className="relative w-full h-full flex items-center justify-center p-2 z-10 bg-white">
                        <img
                            src={imagePreview}
                            alt="Preview"
                            className="max-w-full max-h-[300px] object-contain drop-shadow-sm transition-transform duration-500 group-hover:scale-[1.02]"
                        />
                        <div className="absolute inset-0 bg-slate-900/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-[2px] rounded-2xl">
                            <span className="text-white text-xs font-bold uppercase tracking-widest bg-slate-900/80 px-4 py-2 rounded-xl shadow-xl">
                                {replaceLabel}
                            </span>
                        </div>
                    </div>
                ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center z-10 pointer-events-none">
                        <div className="w-14 h-14 rounded-2xl bg-white shadow-[0_4px_20px_-4px_rgba(0,0,0,0.08)] flex items-center justify-center mb-5 transition-transform duration-300 group-hover:-translate-y-1">
                            <svg className="w-6 h-6 text-[#5b6b7f]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path>
                            </svg>
                        </div>
                        <p className="text-[14px] font-bold text-[#1f2937] tracking-tight mb-1.5">{title}</p>
                        <p className="text-[12px] text-[#6b7280]">{subtitle}</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ImageUpload;
