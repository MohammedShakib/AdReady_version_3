import React, { useEffect, useMemo, useState } from 'react';
import {
    buildMainPrompt,
    buildReferenceAwarePrompt,
    ALLOWED_CTA_VALUES,
    ALLOWED_ASPECT_RATIOS,
    ALLOWED_LIGHTING_FOCUS,
} from '../lib/promptBuilder';

const PromptInput = ({
    onGenerate,
    isGenerating,
    fillValues,
    hasReferenceImage = false,
    referencePipelineStatus = null,
}) => {
    const [productName, setProductName] = useState('');
    const [mainIngredient, setMainIngredient] = useState('');
    const [visualMood, setVisualMood] = useState('');
    const [dynamicElements, setDynamicElements] = useState('');
    const [colorPalette, setColorPalette] = useState('');
    const [backgroundStyle, setBackgroundStyle] = useState('');
    const [brandName, setBrandName] = useState('');
    const [ctaText, setCtaText] = useState('');
    const [aspectRatio, setAspectRatio] = useState('1:1');
    const [lightingFocus, setLightingFocus] = useState('softbox');
    const [extraNotes, setExtraNotes] = useState('');
    const [addQualityTags, setAddQualityTags] = useState(true);
    const [logoImage, setLogoImage] = useState('');
    const [logoFileName, setLogoFileName] = useState('');

    const handleLogoUpload = (event) => {
        const file = event.target.files?.[0];
        if (!file || !file.type.startsWith('image/')) {
            setLogoImage('');
            setLogoFileName('');
            return;
        }
        setLogoFileName(file.name);
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === 'string') {
                setLogoImage(reader.result);
            }
        };
        reader.readAsDataURL(file);
    };

    const handleClear = () => {
        setProductName('');
        setMainIngredient('');
        setVisualMood('');
        setDynamicElements('');
        setColorPalette('');
        setBackgroundStyle('');
        setBrandName('');
        setCtaText('');
        setAspectRatio('1:1');
        setLightingFocus('softbox');
        setExtraNotes('');
        setAddQualityTags(true);
        setLogoImage('');
    };

    const builtPrompt = useMemo(() => {
        const sharedInput = {
            productName,
            mainIngredient,
            visualMood,
            dynamicElements,
            colorPalette,
            backgroundStyle,
            brandName,
            ctaText,
            aspectRatio,
            lightingFocus,
            extraNotes,
            addQualityTags,
            hasLogoImage: Boolean(logoImage),
        };
        return hasReferenceImage
            ? buildReferenceAwarePrompt(sharedInput)
            : buildMainPrompt(sharedInput);
    }, [
        productName,
        mainIngredient,
        visualMood,
        dynamicElements,
        colorPalette,
        backgroundStyle,
        brandName,
        ctaText,
        aspectRatio,
        lightingFocus,
        extraNotes,
        addQualityTags,
        logoImage,
        hasReferenceImage,
    ]);

    useEffect(() => {
        if (!fillValues) {
            return;
        }
        if (typeof fillValues.productName === 'string' && fillValues.productName.trim()) {
            setProductName(fillValues.productName.trim());
        }
        if (typeof fillValues.mainIngredient === 'string' && fillValues.mainIngredient.trim()) {
            setMainIngredient(fillValues.mainIngredient.trim());
        }
        if (typeof fillValues.visualMood === 'string' && fillValues.visualMood.trim()) {
            setVisualMood(fillValues.visualMood.trim());
        }
        if (typeof fillValues.dynamicElements === 'string' && fillValues.dynamicElements.trim()) {
            setDynamicElements(fillValues.dynamicElements.trim());
        }
        if (typeof fillValues.colorPalette === 'string' && fillValues.colorPalette.trim()) {
            setColorPalette(fillValues.colorPalette.trim());
        }
        if (typeof fillValues.backgroundStyle === 'string' && fillValues.backgroundStyle.trim()) {
            setBackgroundStyle(fillValues.backgroundStyle.trim());
        }
        if (typeof fillValues.brandName === 'string' && fillValues.brandName.trim()) {
            setBrandName(fillValues.brandName.trim());
        }
        if (typeof fillValues.ctaText === 'string') {
            const cta = fillValues.ctaText.trim();
            setCtaText(ALLOWED_CTA_VALUES.includes(cta) ? cta : '');
        }
        if (typeof fillValues.aspectRatio === 'string' && fillValues.aspectRatio.trim()) {
            const ratio = fillValues.aspectRatio.trim();
            if (ALLOWED_ASPECT_RATIOS.includes(ratio)) {
                setAspectRatio(ratio);
            }
        }
        if (typeof fillValues.lightingFocus === 'string' && fillValues.lightingFocus.trim()) {
            const lighting = fillValues.lightingFocus.trim();
            if (ALLOWED_LIGHTING_FOCUS.includes(lighting)) {
                setLightingFocus(lighting);
            }
        }
        if (typeof fillValues.extraNotes === 'string' && fillValues.extraNotes.trim()) {
            setExtraNotes(fillValues.extraNotes.trim());
        }
    }, [fillValues]);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!builtPrompt.trim() || !onGenerate) {
            return;
        }
        onGenerate({ prompt: builtPrompt, logoImage });
    };

    return (
        <form onSubmit={handleSubmit} className="w-full flex flex-col gap-4">
            <div className="bg-white border border-[#d0d7e2] rounded-[24px] p-6 shadow-sm">
                
                <div className="flex items-center justify-between mb-6 border-b border-transparent pb-1">
                    <p className="text-[14px] font-extrabold text-[#1f2937]">Creative Direction</p>
                    <button
                        type="button"
                        onClick={handleClear}
                        className="text-[11px] font-bold uppercase tracking-wide px-4 py-1.5 rounded-full border border-slate-200 text-slate-500 bg-white hover:bg-slate-50 transition-colors"
                        disabled={isGenerating}
                    >
                        CLEAR ALL
                    </button>
                </div>
                <div className="grid grid-cols-1 gap-6">
                    <div className="group">
                        <label className="text-[11px] uppercase tracking-widest font-bold text-[#8c9cae] mb-2 block transition-colors">PRODUCT FOCUS</label>
                        <input
                            value={productName}
                            onChange={(e) => setProductName(e.target.value)}
                            placeholder="e.g. 'Strawberry Noir' - Perfume Oil"
                            className="w-full rounded-[14px] border border-[#d0d7e2] bg-white px-4 py-3 text-[#1f2937] font-medium placeholder:text-[#aab3bf] focus:outline-none focus:ring-1 focus:ring-[#1a73e8] focus:border-[#1a73e8] transition-all shadow-[0_2px_4px_rgba(0,0,0,0.02)]"
                            disabled={isGenerating}
                        />
                    </div>
                    <div className="group">
                        <label className="text-[11px] uppercase tracking-widest font-bold text-[#8c9cae] mb-2 block transition-colors">MAIN ELEMENT / THEME</label>
                        <input
                            value={mainIngredient}
                            onChange={(e) => setMainIngredient(e.target.value)}
                            placeholder="e.g. Fresh Strawberries, Water"
                            className="w-full rounded-[14px] border border-[#d0d7e2] bg-white px-4 py-3 text-[#1f2937] font-medium placeholder:text-[#aab3bf] focus:outline-none focus:ring-1 focus:ring-[#1a73e8] focus:border-[#1a73e8] transition-all shadow-[0_2px_4px_rgba(0,0,0,0.02)]"
                            disabled={isGenerating}
                        />
                    </div>
                    <div className="group">
                        <label className="text-[11px] uppercase tracking-widest font-bold text-[#8c9cae] mb-2 block transition-colors">VISUAL MOOD</label>
                        <input
                            value={visualMood}
                            onChange={(e) => setVisualMood(e.target.value)}
                            placeholder="e.g. Premium, Cinematic, Moody"
                            className="w-full rounded-[14px] border border-[#d0d7e2] bg-white px-4 py-3 text-[#1f2937] font-medium placeholder:text-[#aab3bf] focus:outline-none focus:ring-1 focus:ring-[#1a73e8] focus:border-[#1a73e8] transition-all shadow-[0_2px_4px_rgba(0,0,0,0.02)]"
                            disabled={isGenerating}
                        />
                    </div>
                    <div className="group">
                        <label className="text-[11px] uppercase tracking-widest font-bold text-[#8c9cae] mb-2 block transition-colors">DYNAMIC ELEMENTS</label>
                        <input
                            value={dynamicElements}
                            onChange={(e) => setDynamicElements(e.target.value)}
                            placeholder="e.g. Floating ingredients, Water splashes"
                            className="w-full rounded-[14px] border border-[#d0d7e2] bg-white px-4 py-3 text-[#1f2937] font-medium placeholder:text-[#aab3bf] focus:outline-none focus:ring-1 focus:ring-[#1a73e8] focus:border-[#1a73e8] transition-all shadow-[0_2px_4px_rgba(0,0,0,0.02)]"
                            disabled={isGenerating}
                        />
                    </div>
                    <div className="group">
                        <label className="text-[11px] uppercase tracking-widest font-bold text-[#8c9cae] mb-2 block transition-colors">COLOR PALETTE</label>
                        <input
                            value={colorPalette}
                            onChange={(e) => setColorPalette(e.target.value)}
                            placeholder="e.g. Deep crimson, Dark obsidian"
                            className="w-full rounded-[14px] border border-[#d0d7e2] bg-white px-4 py-3 text-[#1f2937] font-medium placeholder:text-[#aab3bf] focus:outline-none focus:ring-1 focus:ring-[#1a73e8] focus:border-[#1a73e8] transition-all shadow-[0_2px_4px_rgba(0,0,0,0.02)]"
                            disabled={isGenerating}
                        />
                    </div>
                    <div className="group">
                        <label className="text-[11px] uppercase tracking-widest font-bold text-[#8c9cae] mb-2 block transition-colors">BACKGROUND ENVIRONMENT</label>
                        <input
                            value={backgroundStyle}
                            onChange={(e) => setBackgroundStyle(e.target.value)}
                            placeholder="e.g. Dark marble surface, Studio lighting"
                            className="w-full rounded-[14px] border border-[#d0d7e2] bg-white px-4 py-3 text-[#1f2937] font-medium placeholder:text-[#aab3bf] focus:outline-none focus:ring-1 focus:ring-[#1a73e8] focus:border-[#1a73e8] transition-all shadow-[0_2px_4px_rgba(0,0,0,0.02)]"
                            disabled={isGenerating}
                        />
                    </div>
                    <div className="group">
                        <label className="text-[11px] uppercase tracking-widest font-bold text-[#8c9cae] mb-2 block transition-colors">BRAND TEXT OVERLAY</label>
                        <input
                            value={brandName}
                            onChange={(e) => setBrandName(e.target.value)}
                            placeholder="e.g. 'Strawberry Noir'"
                            className="w-full rounded-[14px] border border-[#d0d7e2] bg-white px-4 py-3 text-[#1f2937] font-medium placeholder:text-[#aab3bf] focus:outline-none focus:ring-1 focus:ring-[#1a73e8] focus:border-[#1a73e8] transition-all shadow-[0_2px_4px_rgba(0,0,0,0.02)]"
                            disabled={isGenerating}
                        />
                    </div>
                    <div className="group">
                        <label className="text-[11px] uppercase tracking-widest font-bold text-[#8c9cae] mb-3 block transition-colors">BRAND LOGO FILE</label>
                        <div className="flex items-center gap-3">
                            <label className="text-[11px] font-bold uppercase tracking-widest px-4 py-2 rounded-full border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 transition-colors cursor-pointer inline-flex items-center justify-center">
                                Select PNG
                                <input
                                    type="file"
                                    accept="image/png"
                                    className="hidden"
                                    onChange={handleLogoUpload}
                                    disabled={isGenerating}
                                />
                            </label>
                            <span className="text-[12px] text-slate-500 truncate max-w-[150px] font-medium" title={logoFileName}>
                                {logoFileName ? (logoFileName.length > 20 ? `${logoFileName.substring(0, 17)}...` : logoFileName) : 'No file chosen'}
                            </span>
                            {logoImage && (
                                <button
                                    type="button"
                                    className="text-xs text-red-500 bg-red-50 hover:bg-red-100 hover:text-red-700 font-bold px-3 py-1.5 rounded-lg transition-colors border border-red-100"
                                    onClick={() => { setLogoImage(''); setLogoFileName(''); }}
                                    disabled={isGenerating}
                                >
                                    Remove
                                </button>
                            )}
                        </div>
                        {logoImage && (
                            <div className="mt-3 w-full max-w-[160px] rounded-2xl border border-slate-200/80 bg-white shadow-sm p-3 relative group/img">
                                <img src={logoImage} alt="Logo preview" className="max-h-20 object-contain w-full drop-shadow-sm transition-transform group-hover/img:scale-105" />
                                <div className="absolute inset-0 bg-white/40 opacity-0 group-hover/img:opacity-100 transition-opacity rounded-2xl p-2 flex items-center justify-center pointer-events-none">
                                    <span className="text-[10px] font-bold text-slate-800 bg-white/80 px-2 py-1 rounded backdrop-blur-sm">PREVIEW</span>
                                </div>
                            </div>
                        )}
                    </div>
                    <div className="group">
                        <label className="text-[11px] uppercase tracking-widest font-bold text-[#8c9cae] mb-2 block transition-colors">CALL TO ACTION</label>
                        <div className="relative">
                            <select
                                value={ctaText}
                                onChange={(e) => setCtaText(e.target.value)}
                                className="peer w-full rounded-[14px] border border-[#d0d7e2] bg-white px-4 pr-11 py-3 text-[#1f2937] font-medium focus:outline-none focus:ring-1 focus:ring-[#1a73e8] focus:border-[#1a73e8] transition-all appearance-none cursor-pointer shadow-[0_2px_4px_rgba(0,0,0,0.02)]"
                                disabled={isGenerating}
                            >
                                <option value="">None</option>
                                <option value="Shop Now">Shop Now</option>
                                <option value="Buy Now">Buy Now</option>
                                <option value="Learn More">Learn More</option>
                                <option value="Get Offer">Get Offer</option>
                                <option value="Order Today">Order Today</option>
                            </select>
                            <svg className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 peer-focus:text-indigo-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" d="M6 9l6 6 6-6" />
                            </svg>
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-5">
                        <div className="group">
                            <label className="text-[11px] uppercase tracking-widest font-bold text-[#8c9cae] mb-2 block transition-colors">FORMAT</label>
                            <div className="relative">
                                <select
                                    value={aspectRatio}
                                    onChange={(e) => setAspectRatio(e.target.value)}
                                    className="peer w-full rounded-[14px] border border-[#d0d7e2] bg-white px-4 pr-11 py-3 text-[#1f2937] font-medium focus:outline-none focus:ring-1 focus:ring-[#1a73e8] focus:border-[#1a73e8] transition-all appearance-none cursor-pointer shadow-[0_2px_4px_rgba(0,0,0,0.02)]"
                                    disabled={isGenerating}
                                >
                                    <option value="1:1">1:1 (Square)</option>
                                    <option value="9:16">9:16 (Story)</option>
                                    <option value="4:5">4:5 (Portrait)</option>
                                    <option value="16:9">16:9 (Landscape)</option>
                                </select>
                                <svg className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 peer-focus:text-indigo-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" d="M6 9l6 6 6-6" />
                                </svg>
                            </div>
                        </div>
                        <div className="group">
                            <label className="text-[11px] uppercase tracking-widest font-bold text-[#8c9cae] mb-2 block transition-colors">LIGHTING</label>
                            <div className="relative">
                                <select
                                    value={lightingFocus}
                                    onChange={(e) => setLightingFocus(e.target.value)}
                                    className="peer w-full rounded-[14px] border border-[#d0d7e2] bg-white px-4 pr-11 py-3 text-[#1f2937] font-medium focus:outline-none focus:ring-1 focus:ring-[#1a73e8] focus:border-[#1a73e8] transition-all appearance-none cursor-pointer shadow-[0_2px_4px_rgba(0,0,0,0.02)]"
                                    disabled={isGenerating}
                                >
                                    <option value="softbox">Softbox</option>
                                    <option value="cinematic">Cinematic</option>
                                    <option value="studio">Studio</option>
                                    <option value="natural">Natural</option>
                                </select>
                                <svg className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 peer-focus:text-indigo-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" d="M6 9l6 6 6-6" />
                                </svg>
                            </div>
                        </div>
                    </div>
                    <div className="group">
                        <label className="text-[11px] uppercase tracking-widest font-bold text-[#8c9cae] mb-2 block transition-colors">ADDITIONAL DIRECTIVES</label>
                        <textarea
                            value={extraNotes}
                            onChange={(e) => setExtraNotes(e.target.value)}
                            placeholder="Any specific layout instructions or styles..."
                            className="w-full rounded-[14px] border border-[#d0d7e2] bg-white px-4 py-3 text-[#1f2937] font-medium placeholder:text-[#aab3bf] focus:outline-none focus:ring-1 focus:ring-[#1a73e8] focus:border-[#1a73e8] transition-all h-28 resize-none shadow-[0_2px_4px_rgba(0,0,0,0.02)]"
                            disabled={isGenerating}
                        />
                    </div>
                    <label className="flex items-center gap-3 text-sm text-slate-600 mt-2 cursor-pointer w-max group bg-slate-50/80 px-4 py-2 rounded-xl border border-slate-200/50 hover:bg-slate-100/80 transition-colors">
                        <input
                            type="checkbox"
                            checked={addQualityTags}
                            onChange={(e) => setAddQualityTags(e.target.checked)}
                            className="accent-indigo-500 w-4.5 h-4.5 rounded border-slate-300 cursor-pointer shadow-sm"
                            disabled={isGenerating}
                        />
                        <span className="font-medium group-hover:text-slate-900 transition-colors">Enhance quality tags (8k, cinematic)</span>
                    </label>
                </div>
            </div>

            {hasReferenceImage ? (
                <div className="bg-slate-50 border border-[#d0d7e2] rounded-2xl p-4 text-slate-700 relative overflow-hidden">
                    <div className="text-[10px] uppercase tracking-widest text-[#1a73e8] mb-3 font-sans font-bold flex items-center gap-2">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path></svg>
                        {referencePipelineStatus?.title || 'Reference-img-pipeline-1'}
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-white p-3">
                        <p className="text-[10px] uppercase tracking-widest font-bold text-slate-500">
                            {isGenerating ? 'Current Step' : 'Status'}
                        </p>
                        <p className="mt-2 text-xs leading-relaxed text-slate-700">
                            {referencePipelineStatus?.message || 'Ready. Click Generate Design to run the pipeline.'}
                        </p>
                        {isGenerating && (
                            <div className="mt-2 inline-flex items-center gap-2 text-[11px] text-indigo-600 font-semibold">
                                <span className="inline-block w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
                                Running...
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <div className="bg-slate-50 border border-[#d0d7e2] rounded-2xl p-4 text-xs text-slate-600 font-mono relative overflow-hidden">
                    <div className="text-[10px] uppercase tracking-widest text-[#1a73e8] mb-2 font-sans font-bold flex items-center gap-2">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path></svg>
                        Underlying Prompt
                    </div>
                    <p className="leading-relaxed whitespace-pre-wrap font-medium">{builtPrompt}</p>
                </div>
            )}

            <button
                type="submit"
                disabled={isGenerating}
                className={`w-full bg-[#1a73e8] hover:bg-blue-600 text-white font-bold py-4 px-6 rounded-2xl transition-all duration-300 flex items-center justify-center gap-3 group relative overflow-hidden ${isGenerating ? 'opacity-70 cursor-not-allowed' : 'hover:-translate-y-0.5 shadow-md hover:shadow-lg'}`}
            >
                <div className="absolute inset-0 bg-white/20 translate-y-[-100%] group-hover:translate-y-[100%] transition-transform duration-700 ease-in-out" />
                {isGenerating ? (
                    <>
                        <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        <span>Generating...</span>
                    </>
                ) : (
                    <>
                        <span className="text-base tracking-wide">Generate Design</span>
                        <svg className="w-5 h-5 opacity-90 group-hover:translate-x-1.5 transition-transform duration-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
                        </svg>
                    </>
                )}
            </button>
        </form>
    );
};

export default PromptInput;
