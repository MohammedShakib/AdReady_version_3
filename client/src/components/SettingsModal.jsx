import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Mail, User } from 'lucide-react';
import PhoneInput from 'react-phone-input-2';
import 'react-phone-input-2/lib/style.css';
import { apiUrl } from '../lib/api';

const formatLastLogin = (value) => {
  if (!value) {
    return 'No login history yet';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'No login history yet';
  }
  return date.toLocaleString();
};

const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '');
const PLAN_FALLBACK_OPTIONS = [
  {
    tier: 'basic',
    name: 'Basic',
    priceUsdMonthly: 30,
    monthlyCredits: 100,
  },
  {
    tier: 'pro',
    name: 'Pro',
    priceUsdMonthly: 50,
    monthlyCredits: 250,
  },
];

const SettingsModal = ({
  isOpen,
  onClose,
  authToken,
  fallbackUsername,
  fallbackRole,
  onProfileUpdated,
}) => {
  const [profile, setProfile] = useState(null);
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState({
    username: '',
    email: '',
    phone: '',
  });
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [isCreatingCheckoutPlan, setIsCreatingCheckoutPlan] = useState('');
  const [billingError, setBillingError] = useState('');
  const [planOptions, setPlanOptions] = useState(PLAN_FALLBACK_OPTIONS);

  useEffect(() => {
    if (!isOpen) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setProfileError('');
      setProfileSuccess('');
      setPasswordError('');
      setPasswordSuccess('');
      setIsEditingProfile(false);
      setIsCreatingCheckoutPlan('');
      setBillingError('');
      setPlanOptions(PLAN_FALLBACK_OPTIONS);
      return;
    }

    if (!authToken) {
      setProfile(null);
      return;
    }

    let cancelled = false;
    const loadProfile = async () => {
      setIsLoadingProfile(true);
      try {
        const [profileRes, plansRes] = await Promise.all([
          fetch(apiUrl('/api/auth/me'), {
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
          }),
          fetch(apiUrl('/api/billing/plans'), {
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
          }),
        ]);

        const data = await profileRes.json().catch(() => ({}));
        if (!profileRes.ok) {
          throw new Error(data?.error || data?.details || 'Failed to load profile');
        }
        if (!cancelled) {
          const loadedUser = data?.user || null;
          setProfile(loadedUser);
          setProfileForm({
            username: loadedUser?.username || '',
            email: loadedUser?.email || '',
            phone: normalizePhoneDigits(loadedUser?.phone),
          });

          const plansPayload = await plansRes.json().catch(() => ({}));
          const livePlans = Array.isArray(plansPayload?.plans) ? plansPayload.plans : [];
          const paidPlans = livePlans.filter((plan) => String(plan?.tier || '').toLowerCase() !== 'free');
          setPlanOptions(
            paidPlans.length
              ? paidPlans.map((plan) => ({
                  tier: String(plan.tier || '').toLowerCase(),
                  name: plan.name || String(plan.tier || '').toUpperCase(),
                  priceUsdMonthly: Number(plan.priceUsdMonthly || 0),
                  monthlyCredits: Number(plan.monthlyCredits || 0),
                }))
              : PLAN_FALLBACK_OPTIONS
          );
        }
      } catch (err) {
        if (!cancelled) {
          setProfileError(err?.message || 'Failed to load profile');
        }
      } finally {
        if (!cancelled) {
          setIsLoadingProfile(false);
        }
      }
    };

    loadProfile();
    return () => {
      cancelled = true;
    };
  }, [isOpen, authToken]);

  const username = profile?.username || fallbackUsername || 'User';
  const role = profile?.role || fallbackRole || 'member';
  const isAdminAccount = String(role || '').toLowerCase() === 'admin';
  const hasUnlimitedUsage = Boolean(profile?.hasUnlimitedUsage) || isAdminAccount;
  const credits = Number(profile?.credits || 0);
  const currentPlanTier = String(profile?.planTier || 'free').toLowerCase();
  const currentPlanLabel = hasUnlimitedUsage ? 'ADMIN' : currentPlanTier.toUpperCase();
  const monthlyCreditQuota = hasUnlimitedUsage
    ? null
    : Number(profile?.monthlyCreditQuota || profile?.dailyCreditQuota || 5);
  const userInitial = useMemo(() => username.charAt(0).toUpperCase(), [username]);

  const handleProfileField = (field, value) => {
    setProfileForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSaveProfile = async () => {
    setProfileError('');
    setProfileSuccess('');

    if (!profileForm.username.trim()) {
      setProfileError('Full name is required');
      return;
    }

    setIsSavingProfile(true);
    try {
      const response = await fetch(apiUrl('/api/auth/profile'), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          username: profileForm.username,
          email: profileForm.email,
          phone: profileForm.phone ? `+${profileForm.phone}` : '',
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || data?.details || 'Profile update failed');
      }

      const updatedUser = data?.user || null;
      setProfile(updatedUser);
      setProfileForm({
        username: updatedUser?.username || '',
        email: updatedUser?.email || '',
        phone: normalizePhoneDigits(updatedUser?.phone),
      });
      setProfileSuccess('Profile updated successfully.');
      setIsEditingProfile(false);
      if (updatedUser?.username) {
        localStorage.setItem('username', updatedUser.username);
      }
      if (updatedUser?.role) {
        localStorage.setItem('userRole', updatedUser.role);
      }
      if (typeof updatedUser?.isSuperAdmin === 'boolean') {
        localStorage.setItem('isSuperAdmin', updatedUser.isSuperAdmin ? 'true' : 'false');
      }
      onProfileUpdated?.(updatedUser);
    } catch (err) {
      setProfileError(err?.message || 'Profile update failed');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleUpgradePlan = async (planTier) => {
    setBillingError('');
    if (!authToken) {
      setBillingError('You must be logged in to upgrade.');
      return;
    }

    setIsCreatingCheckoutPlan(planTier);
    try {
      const response = await fetch(apiUrl('/api/billing/create-checkout-session'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ planTier }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || data?.details || 'Failed to start checkout');
      }
      if (!data?.url) {
        throw new Error('Stripe checkout URL missing');
      }
      window.location.href = data.url;
    } catch (error) {
      setBillingError(error?.message || 'Failed to start checkout');
    } finally {
      setIsCreatingCheckoutPlan('');
    }
  };

  const handleChangePassword = async (event) => {
    event.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');

    if (!newPassword || newPassword.length < 6) {
      setPasswordError('New password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirm password do not match.');
      return;
    }

    setIsSavingPassword(true);
    try {
      const response = await fetch(apiUrl('/api/auth/change-password'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || data?.details || 'Password change failed');
      }

      setPasswordSuccess('Password updated successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPasswordError(err?.message || 'Password change failed');
    } finally {
      setIsSavingPassword(false);
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/45"
        onClick={onClose}
        aria-label="Close settings"
      />

      <div className="relative w-full max-w-6xl max-h-[92vh] overflow-y-auto rounded-3xl border border-slate-200 bg-slate-50 p-6 shadow-2xl md:p-8">
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-xl font-bold text-slate-900">Profile Settings</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:border-slate-300 hover:text-slate-900"
          >
            Close
          </button>
        </div>

        <section className="mb-8 rounded-3xl border border-slate-200 bg-gradient-to-r from-indigo-50 via-fuchsia-50 to-cyan-50 p-6 shadow-sm">
          <div className="flex flex-col gap-5 md:flex-row md:items-center">
            <div className="relative">
              <div className="flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 text-4xl font-bold text-white shadow-lg">
                {userInitial}
              </div>
              <div className="absolute -bottom-1 -right-1 rounded-full bg-emerald-500 p-1 text-white shadow">
                <CheckCircle2 className="h-5 w-5" />
              </div>
            </div>

            <div className="flex-1">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-white/80 px-3 py-1 text-xs font-bold uppercase tracking-wide text-violet-600">
                  Active Account
                </span>
                <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-700">
                  {hasUnlimitedUsage ? 'Role' : 'Plan'}: {currentPlanLabel}
                </span>
                {hasUnlimitedUsage ? (
                  <span className="rounded-full bg-cyan-100 px-3 py-1 text-xs font-semibold text-cyan-700">
                    Unlimited access
                  </span>
                ) : (
                  <>
                    <span className="rounded-full bg-slate-200/70 px-3 py-1 text-xs font-semibold text-slate-600">
                      {credits} credits
                    </span>
                    <span className="rounded-full bg-cyan-100 px-3 py-1 text-xs font-semibold text-cyan-700">
                      Monthly quota: {monthlyCreditQuota}
                    </span>
                  </>
                )}
              </div>
              <h4 className="text-4xl font-extrabold tracking-tight text-slate-900">{username}</h4>
              <p className="text-xl text-slate-600">{profile?.email || 'No email set'}</p>
              <p className="mt-1 text-sm text-slate-500">Last login: {formatLastLogin(profile?.lastLoginAt)}</p>
            </div>
          </div>
        </section>

        {!hasUnlimitedUsage && (
          <section className="mb-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-5">
              <h4 className="text-2xl font-extrabold text-slate-900">Upgrade Plan</h4>
              <p className="text-slate-500">Choose a monthly subscription and pay securely with Stripe.</p>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {planOptions.map((plan) => {
                const isCurrent = currentPlanTier === plan.tier;
                const isLoading = isCreatingCheckoutPlan === plan.tier;
                return (
                  <div
                    key={plan.tier}
                    className={`rounded-2xl border p-5 ${isCurrent ? 'border-indigo-500 bg-indigo-50/50' : 'border-slate-200 bg-slate-50'}`}
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <h5 className="text-xl font-bold text-slate-900">{plan.name}</h5>
                      {isCurrent && (
                        <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-bold text-indigo-700">
                          Current
                        </span>
                      )}
                    </div>
                    <p className="text-3xl font-black text-slate-900">
                      ${plan.priceUsdMonthly}
                      <span className="ml-1 text-base font-medium text-slate-500">/month</span>
                    </p>
                    <p className="mt-2 text-sm text-slate-600">{plan.monthlyCredits} credits per month</p>
                    <button
                      type="button"
                      disabled={isCurrent || isLoading}
                      onClick={() => handleUpgradePlan(plan.tier)}
                      className="mt-4 w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      {isCurrent ? 'Active Plan' : isLoading ? 'Redirecting...' : `Upgrade to ${plan.name}`}
                    </button>
                  </div>
                );
              })}
            </div>
            {billingError && <p className="mt-4 text-sm font-medium text-red-500">{billingError}</p>}
          </section>
        )}

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-6 flex items-center justify-between gap-3">
            <div>
              <h4 className="text-3xl font-extrabold text-slate-900">Account Information</h4>
              <p className="text-lg text-slate-500">Update your personal details</p>
            </div>
            <button
              type="button"
              onClick={() => setIsEditingProfile((prev) => !prev)}
              className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-300 hover:bg-slate-100"
            >
              {isEditingProfile ? 'Cancel' : 'Edit'}
            </button>
          </div>

          {isLoadingProfile ? (
            <p className="text-sm text-slate-500">Loading profile...</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <label className="block">
                  <span className="mb-2 block text-sm font-bold text-slate-700">Full Name</span>
                  <div className="relative">
                    <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <input
                      value={profileForm.username}
                      onChange={(e) => handleProfileField('username', e.target.value)}
                      disabled={!isEditingProfile}
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 py-3 pl-10 pr-3 text-slate-800 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20 disabled:cursor-not-allowed disabled:opacity-80"
                    />
                  </div>
                </label>

                <label className="block">
                  <span className="mb-2 block text-sm font-bold text-slate-700">Email Address</span>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <input
                      value={profileForm.email}
                      onChange={(e) => handleProfileField('email', e.target.value)}
                      disabled={!isEditingProfile}
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 py-3 pl-10 pr-3 text-slate-800 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/20 disabled:cursor-not-allowed disabled:opacity-80"
                    />
                  </div>
                </label>
              </div>

              <div className="mt-5">
                <label className="block">
                  <span className="mb-2 block text-sm font-bold text-slate-700">Phone Number</span>
                  <div className={isEditingProfile ? '' : 'opacity-80'}>
                    <PhoneInput
                      country="bd"
                      value={profileForm.phone}
                      onChange={(value) => handleProfileField('phone', String(value || '').replace(/\D/g, ''))}
                      disabled={!isEditingProfile}
                      enableSearch
                      countryCodeEditable={false}
                      inputProps={{ name: 'phone' }}
                      containerStyle={{ width: '100%' }}
                      inputStyle={{
                        width: '100%',
                        height: '48px',
                        borderRadius: '12px',
                        border: '1px solid #e2e8f0',
                        background: '#f8fafc',
                        color: '#0f172a',
                        paddingLeft: '58px',
                        fontSize: '15px',
                      }}
                      buttonStyle={{
                        borderTopLeftRadius: '12px',
                        borderBottomLeftRadius: '12px',
                        borderColor: '#e2e8f0',
                        background: '#f8fafc',
                      }}
                      dropdownStyle={{
                        maxHeight: '220px',
                        overflowY: 'auto',
                        zIndex: 9999,
                      }}
                      searchStyle={{
                        width: '100%',
                        margin: 0,
                        borderRadius: '8px',
                        border: '1px solid #e2e8f0',
                      }}
                      placeholder="Enter phone number"
                    />
                  </div>
                </label>
              </div>

              {profileError && <p className="mt-4 text-sm font-medium text-red-500">{profileError}</p>}
              {profileSuccess && <p className="mt-4 text-sm font-medium text-emerald-600">{profileSuccess}</p>}

              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={handleSaveProfile}
                  disabled={!isEditingProfile || isSavingProfile}
                  className="rounded-xl bg-slate-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSavingProfile ? 'Saving...' : 'Save Profile'}
                </button>
              </div>
            </>
          )}
        </section>

        <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h4 className="mb-3 text-base font-bold text-slate-900">Security</h4>
          <form onSubmit={handleChangePassword} className="space-y-3">
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Current password"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
            {passwordError && <p className="text-sm text-red-500">{passwordError}</p>}
            {passwordSuccess && <p className="text-sm text-emerald-600">{passwordSuccess}</p>}
            <button
              type="submit"
              disabled={isSavingPassword}
              className="inline-flex items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSavingPassword ? 'Saving...' : 'Update Password'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};

export default SettingsModal;
