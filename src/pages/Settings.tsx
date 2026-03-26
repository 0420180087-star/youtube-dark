import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { encryptData, decryptData } from '../services/securityService';
import { Settings as SettingsIcon, User, Key, Shield, LogOut, Save, CheckCircle, RefreshCw, AlertTriangle, Trash2, Youtube, LogIn, Copy, ExternalLink, Plus, X, Link2, Activity } from 'lucide-react';
import { getKeyStatus, clearExhaustedKeys } from '../services/geminiService';

export const Settings: React.FC = () => {
    const { user, login, logout, googleClientId, setGoogleClientId, isLoading: isAuthLoading, youtubeChannel, connectYoutube, disconnectYoutube } = useAuth();
    
    // Storage keys
    const singleKeyStorageKey = user?.email ? `ds_api_key_${user.email}` : 'ds_api_key';
    const multiKeyStorageKey = user?.email ? `ds_api_keys_list_${user.email}` : 'ds_api_keys_list';

    // State
    const [apiKeys, setApiKeys] = useState<string[]>([]);
    const [pexelsKey, setPexelsKey] = useState('');
    const [newKeyInput, setNewKeyInput] = useState('');
    const [clientIdInput, setClientIdInput] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [hasEnvKey, setHasEnvKey] = useState(false);
    
    const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
    
    useEffect(() => {
        // Check for environment keys
        // Direct access allows Vite's 'define' to replace these strings during build
        // @ts-ignore
        const k1 = process.env.GEMINI_API_KEY;
        // @ts-ignore
        const k2 = process.env.API_KEY;
        const envKey = (k1 && k1.length > 20) || (k2 && k2.length > 20);
        setHasEnvKey(!!envKey);

        // 1. Load Keys (Async Decryption)
        const loadKeys = async () => {
            // Try loading new list format
            const storedListEnc = localStorage.getItem(multiKeyStorageKey);
            if (storedListEnc) {
                try {
                    const decrypted = await decryptData(storedListEnc);
                    const parsed = JSON.parse(decrypted);
                    if (Array.isArray(parsed)) {
                        setApiKeys(parsed);
                        return;
                    }
                } catch (e) {}
            }

            // Fallback: Check for old single key format and migrate
            const singleKeyEnc = localStorage.getItem(singleKeyStorageKey) || localStorage.getItem('ds_api_key');
            if (singleKeyEnc) {
                try {
                    const decrypted = await decryptData(singleKeyEnc);
                    setApiKeys([decrypted]);
                } catch(e) {}
            }
        };

        loadKeys();
        
        // Load Pexels Key
        const loadPexels = async () => {
            const stored = localStorage.getItem('ds_pexels_api_key');
            if (stored) {
                try {
                    const decrypted = await decryptData(stored);
                    setPexelsKey(decrypted);
                } catch (e) {}
            }
        };
        loadPexels();

        setClientIdInput(googleClientId);
    }, [googleClientId, user, singleKeyStorageKey, multiKeyStorageKey]);

    const handleAddKey = () => {
        const cleanKey = newKeyInput.trim();
        if (!cleanKey) return;
        
        if (apiKeys.includes(cleanKey)) {
            alert("Esta chave já foi adicionada.");
            return;
        }
        
        setApiKeys([...apiKeys, cleanKey]);
        setNewKeyInput('');
    };

    const handleRemoveKey = (index: number) => {
        const newList = [...apiKeys];
        newList.splice(index, 1);
        setApiKeys(newList);
    };

    const handleSave = async () => {
        setIsSaving(true);
        setSaveSuccess(false);
        
        try {
            // 1. Encrypt and Save API Keys (As Array)
            if (apiKeys.length > 0) {
                const encList = await encryptData(JSON.stringify(apiKeys));
                localStorage.setItem(multiKeyStorageKey, encList);
                
                // CRITICAL: Clean up legacy slots to prevent "ghost" key usage
                localStorage.removeItem(singleKeyStorageKey);
                localStorage.removeItem('ds_api_key');
            } else {
                localStorage.removeItem(multiKeyStorageKey);
                localStorage.removeItem(singleKeyStorageKey);
                if (!user) localStorage.removeItem('ds_api_key');
            }

            // 2. Save Pexels Key
            if (pexelsKey.trim()) {
                const encPexels = await encryptData(pexelsKey.trim());
                localStorage.setItem('ds_pexels_api_key', encPexels);
            } else {
                localStorage.removeItem('ds_pexels_api_key');
            }

            // 3. Save Client ID (Via Context which handles encryption)
            const cleanClientId = clientIdInput.trim();
            
            // Basic validation for Google Client ID
            if (cleanClientId && !cleanClientId.endsWith('.apps.googleusercontent.com')) {
                if (!confirm("O Client ID inserido não parece ser um ID padrão do Google (deve terminar em .apps.googleusercontent.com). Deseja salvar mesmo assim?")) {
                    setIsSaving(false);
                    return;
                }
            }

            setGoogleClientId(cleanClientId);
            
            setTimeout(() => {
                setIsSaving(false);
                setSaveSuccess(true);
                setTimeout(() => setSaveSuccess(false), 3000);
            }, 800);
        } catch (e) {
            console.error("Save Error", e);
            alert("Error saving encrypted settings.");
            setIsSaving(false);
        }
    };
    
    const copyOrigin = () => {
        navigator.clipboard.writeText(currentOrigin);
        alert(`Copiado: ${currentOrigin}\n\nCole no Google Cloud Console.`);
    };

    return (
        <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
            
            <div className="flex items-center gap-4 mb-8">
                <div className="p-3 bg-orange-500/10 rounded-2xl border border-orange-500/20">
                    <SettingsIcon className="w-8 h-8 text-orange-400" />
                </div>
                <div>
                    <h1 className="text-3xl font-bold text-white">Configurações</h1>
                    <p className="text-slate-400">Gerencie chaves, integrações e conta.</p>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-8">
                
                {/* API CONFIGURATION */}
                <section className="bg-slate-900/40 border border-slate-800 rounded-2xl overflow-hidden">
                    <div className="p-6 border-b border-slate-800 bg-slate-900/60">
                        <h2 className="text-lg font-bold text-white flex items-center gap-2">
                            <Key className="w-5 h-5 text-orange-400" />
                            Configuração Gemini API (Criptografado)
                        </h2>
                    </div>
                    
                    <div className="p-6 space-y-6">
                         <div>
                            <div className="flex justify-between items-center mb-2">
                                <label className="block text-sm font-medium text-slate-300">
                                    Chaves de API {user ? `(Para ${user.name})` : '(Convidado)'}
                                </label>
                                {apiKeys.length > 0 ? (
                                    <span className="text-[10px] bg-green-500/10 text-green-400 border border-green-500/20 px-2 py-0.5 rounded flex items-center gap-1">
                                        <CheckCircle className="w-3 h-3" /> {apiKeys.length} Chave(s)
                                    </span>
                                ) : hasEnvKey ? (
                                   <span className="text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded flex items-center gap-1">
                                       <Shield className="w-3 h-3" /> Chave do Sistema Ativa
                                   </span>
                                ) : null}
                            </div>


                            {hasEnvKey && apiKeys.length === 0 && (
                               <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg flex items-center gap-3">
                                   <Shield className="w-5 h-5 text-blue-400" />
                                   <p className="text-xs text-blue-300">
                                       Uma chave de API do sistema foi detectada. O DarkStream AI usará esta chave automaticamente. 
                                       Você pode adicionar chaves adicionais abaixo para aumentar sua cota.
                                   </p>
                               </div>
                            )}

                            {/* List of Active Keys */}
                            {apiKeys.length > 0 && (
                                <div className="space-y-2 mb-4">
                                    {apiKeys.map((k, idx) => (
                                        <div key={idx} className="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
                                            <div className="flex items-center gap-2 text-slate-400 font-mono text-xs">
                                                <Key className="w-3 h-3 text-slate-600" />
                                                <span>•••••••••••••••••••••{k.slice(-4)}</span>
                                                <span className="text-[9px] bg-slate-800 px-1 rounded text-slate-500">#{idx + 1}</span>
                                                <span className="text-[9px] bg-green-500/10 text-green-400 border border-green-500/20 px-1.5 py-0.5 rounded flex items-center gap-1">
                                                    <Activity className="w-2.5 h-2.5" /> Ativa
                                                </span>
                                            </div>
                                            <button onClick={() => handleRemoveKey(idx)} className="text-slate-500 hover:text-red-400 p-1">
                                                <X className="w-4 h-4" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Add New Key Input */}
                            <div className="flex gap-2">
                                <div className="relative flex-1">
                                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                        <Shield className="h-4 w-4 text-slate-500" />
                                    </div>
                                    <input
                                        type="password"
                                        value={newKeyInput}
                                        onChange={(e) => setNewKeyInput(e.target.value)}
                                        placeholder="Adicionar nova chave do AI Studio"
                                        className="block w-full pl-10 pr-3 py-2.5 border border-slate-700 rounded-lg leading-5 bg-slate-950 text-slate-300 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-orange-500 sm:text-sm"
                                        onKeyDown={(e) => e.key === 'Enter' && handleAddKey()}
                                    />
                                </div>
                                <button 
                                    onClick={handleAddKey}
                                    disabled={!newKeyInput}
                                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg border border-slate-700 font-medium disabled:opacity-50 flex items-center gap-2"
                                >
                                    <Plus className="w-4 h-4" /> Adicionar
                                </button>
                            </div>
                            <p className="mt-2 text-xs text-slate-500">
                                As chaves são criptografadas com AES-GCM antes de serem salvas.
                                <br/>Obtenha em <a href="https://aistudio.google.com/app/apikey" target="_blank" className="text-orange-400 hover:underline">Google AI Studio</a>.
                            </p>
                        </div>
                    </div>
                </section>

                {/* PEXELS CONFIGURATION */}
                <section className="bg-slate-900/40 border border-slate-800 rounded-2xl overflow-hidden">
                    <div className="p-6 border-b border-slate-800 bg-slate-900/60">
                        <h2 className="text-lg font-bold text-white flex items-center gap-2">
                            <Activity className="w-5 h-5 text-emerald-400" />
                            Configuração Pexels API (Banco de Vídeos)
                        </h2>
                    </div>
                    
                    <div className="p-6 space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-slate-300 mb-2">
                                Chave de API Pexels
                            </label>
                            <div className="relative">
                                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                    <Key className="h-4 w-4 text-slate-500" />
                                </div>
                                <input
                                    type="password"
                                    value={pexelsKey}
                                    onChange={(e) => setPexelsKey(e.target.value)}
                                    placeholder="Cole sua chave da Pexels aqui"
                                    className="block w-full pl-10 pr-3 py-2.5 border border-slate-700 rounded-lg leading-5 bg-slate-950 text-slate-300 placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 sm:text-sm"
                                />
                            </div>
                            <p className="mt-2 text-xs text-slate-500">
                                Usada para buscar filmagens de estoque (stock footage) quando o Gemini não gera imagens.
                                <br/>Obtenha em <a href="https://www.pexels.com/api/new/" target="_blank" className="text-emerald-400 hover:underline">Pexels API</a>.
                            </p>
                        </div>
                    </div>
                </section>

                {/* ACCOUNT INTEGRATION */}
                <section className="bg-slate-900/40 border border-slate-800 rounded-2xl overflow-hidden">
                    <div className="p-6 border-b border-slate-800 bg-slate-900/60 flex justify-between items-center">
                        <h2 className="text-lg font-bold text-white flex items-center gap-2">
                            <User className="w-5 h-5 text-orange-400" />
                            Integração Conta Google
                        </h2>
                    </div>
                    
                    <div className="p-6 space-y-6">
                         <div className="p-5 bg-yellow-900/10 border border-yellow-700/30 rounded-xl mb-4 space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-yellow-500 uppercase tracking-wider mb-2">
                                    1. Google Client ID (Obrigatório)
                                </label>
                                <input
                                    type="text"
                                    value={clientIdInput}
                                    onChange={(e) => setClientIdInput(e.target.value)}
                                    placeholder="ex: 12345...apps.googleusercontent.com"
                                    className="block w-full px-4 py-2 border border-slate-700 rounded-lg bg-slate-950 text-slate-300 text-sm focus:outline-none focus:border-orange-500 transition-colors"
                                />
                            </div>

                            <div className="bg-slate-950 p-4 rounded-lg border border-yellow-500/20">
                                <label className="block text-xs font-bold text-orange-400 uppercase tracking-wider mb-2 flex items-center gap-2">
                                    <AlertTriangle className="w-4 h-4" /> 2. Origem Javascript (Correção Erro 400)
                                </label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        readOnly
                                        value={currentOrigin}
                                        className="block w-full px-4 py-2 border border-slate-700 rounded-lg bg-slate-900 text-green-400 font-bold text-sm font-mono"
                                    />
                                    <button onClick={copyOrigin} className="px-4 bg-orange-600 hover:bg-orange-500 text-white rounded-lg font-bold flex items-center gap-2"><Copy className="w-4 h-4" /> Copiar</button>
                                </div>
                                <div className="mt-3 flex items-center gap-2">
                                    <a href="https://console.cloud.google.com/apis/credentials" target="_blank" className="text-xs text-blue-400 hover:underline flex items-center gap-1">Ir para Google Cloud Console <ExternalLink className="w-3 h-3" /></a>
                                </div>
                            </div>
                        </div>

                        <div className={`transition-opacity duration-300 ${!clientIdInput ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 p-4 rounded-xl border border-slate-800 bg-slate-950/50 relative overflow-hidden mb-6">
                                {user ? (
                                    <>
                                        <div className="flex items-center gap-4 z-10">
                                            <div className="w-14 h-14 rounded-full border-2 border-orange-500/50 p-0.5">
                                                <img src={user.picture} alt={user.name} className="w-full h-full rounded-full object-cover" />
                                            </div>
                                            <div>
                                                <h3 className="font-bold text-white text-lg">{user.name}</h3>
                                                <p className="text-sm text-slate-400">{user.email}</p>
                                            </div>
                                        </div>
                                        <button onClick={logout} className="z-10 flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20"><LogOut className="w-4 h-4" /> Sair</button>
                                    </>
                                ) : (
                                    <>
                                        <div className="flex items-center gap-4 z-10">
                                            <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center"><User className="w-6 h-6 text-slate-500" /></div>
                                            <div><h3 className="font-bold text-white text-lg">Modo Convidado</h3><p className="text-sm text-slate-400">Faça login para salvar.</p></div>
                                        </div>
                                        <button onClick={login} disabled={isAuthLoading || !clientIdInput} className="z-10 flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold bg-white text-slate-900 hover:bg-orange-50 disabled:opacity-50">{isAuthLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />} Entrar</button>
                                    </>
                                )}
                            </div>

                            {user && (
                                <div className="pt-6 border-t border-slate-800">
                                    <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2"><Youtube className="w-4 h-4" /> Passo 3: Canal YouTube</h3>
                                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 p-4 rounded-xl border border-slate-800 bg-slate-950/50">
                                        {youtubeChannel ? (
                                            <>
                                                <div className="flex items-center gap-4">
                                                    <div className="w-12 h-12 bg-red-600 rounded-lg flex items-center justify-center shadow-lg"><Youtube className="w-6 h-6 text-white" /></div>
                                                    <div><h3 className="font-bold text-white text-lg">{youtubeChannel.title}</h3><div className="text-sm text-slate-400 text-green-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Conectado</div></div>
                                                </div>
                                                <button onClick={disconnectYoutube} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm border border-slate-700">Desconectar</button>
                                            </>
                                        ) : (
                                            <>
                                                <div className="flex items-center gap-4"><div className="w-12 h-12 bg-slate-800 rounded-lg flex items-center justify-center border border-slate-700"><Link2 className="w-6 h-6 text-slate-500" /></div><div><h3 className="font-bold text-white text-lg">Sem Canal</h3><p className="text-sm text-slate-400">Vincule para upload automático.</p></div></div>
                                                <button onClick={connectYoutube} disabled={isAuthLoading} className="px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-bold shadow-lg flex items-center gap-2">{isAuthLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Youtube className="w-4 h-4" />} Conectar</button>
                                            </>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </section>

                <div className="flex justify-end pt-4">
                    <button 
                        onClick={handleSave}
                        disabled={isSaving}
                        className={`flex items-center gap-2 text-white px-8 py-3 rounded-xl font-bold shadow-lg transition-all disabled:opacity-70 active:scale-95 ${saveSuccess ? 'bg-green-600 hover:bg-green-500' : 'bg-orange-600 hover:bg-orange-500'}`}
                    >
                        {isSaving ? <RefreshCw className="w-5 h-5 animate-spin" /> : saveSuccess ? <CheckCircle className="w-5 h-5" /> : <Save className="w-5 h-5" />}
                        {isSaving ? 'Salvando...' : saveSuccess ? 'Salvo!' : 'Salvar e Criptografar'}
                    </button>
                </div>
            </div>
        </div>
    );
};