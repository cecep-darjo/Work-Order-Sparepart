import { useState, type FormEvent } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { ROLE_LABELS } from '@/lib/supabase';
import { validatePassword } from '@/lib/authUsername';
import { Button, Card, Input, Label } from '@/components/ui';
import { KeyRound, UserRound } from 'lucide-react';

export default function UserSettings() {
  const { profile, session, refreshProfile } = useAuth();
  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [nameSaving, setNameSaving] = useState(false);
  const [nameMessage, setNameMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  if (!profile) return null;

  async function saveFullName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = fullName.trim();
    if (!normalizedName) {
      setNameMessage({ tone: 'error', text: 'Nama lengkap wajib diisi.' });
      return;
    }
    if (normalizedName.length > 120) {
      setNameMessage({ tone: 'error', text: 'Nama lengkap maksimal 120 karakter.' });
      return;
    }
    if (normalizedName === profile.full_name) {
      setNameMessage({ tone: 'success', text: 'Nama lengkap tidak berubah.' });
      return;
    }

    setNameSaving(true);
    setNameMessage(null);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .update({ full_name: normalizedName })
        .eq('id', profile.id)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Profil tidak ditemukan atau perubahan tidak diizinkan.');

      await refreshProfile();
      setNameMessage({ tone: 'success', text: 'Nama lengkap berhasil diperbarui.' });
    } catch (error) {
      setNameMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Gagal memperbarui nama lengkap.' });
    } finally {
      setNameSaving(false);
    }
  }

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordMessage(null);

    const passwordError = validatePassword(newPassword);
    if (!currentPassword) {
      setPasswordMessage({ tone: 'error', text: 'Password saat ini wajib diisi untuk verifikasi.' });
      return;
    }
    if (passwordError) {
      setPasswordMessage({ tone: 'error', text: passwordError });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMessage({ tone: 'error', text: 'Konfirmasi password baru tidak sama.' });
      return;
    }
    if (!session?.user.email) {
      setPasswordMessage({ tone: 'error', text: 'Identitas login tidak tersedia. Silakan masuk kembali.' });
      return;
    }

    setPasswordSaving(true);
    try {
      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email: session.user.email,
        password: currentPassword,
      });
      if (verifyError) throw new Error('Password saat ini salah.');

      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage({ tone: 'success', text: 'Password berhasil diperbarui.' });
    } catch (error) {
      setPasswordMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Gagal memperbarui password.' });
    } finally {
      setPasswordSaving(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-5">
      <Card className="p-5">
        <div className="mb-5">
          <h2 className="font-semibold text-slate-900">Informasi Akun</h2>
          <p className="mt-1 text-sm text-slate-500">Pengaturan ini hanya mengubah akun yang sedang login.</p>
        </div>
        <div className="mb-5 rounded-lg bg-slate-50 p-3 text-sm">
          <p><span className="text-slate-500">Username:</span> <span className="font-medium text-slate-800">{profile.username ?? '-'}</span></p>
          <p className="mt-1"><span className="text-slate-500">Role:</span> <span className="font-medium text-slate-800">{ROLE_LABELS[profile.role]}</span></p>
        </div>
        <form onSubmit={saveFullName} className="space-y-3">
          <div>
            <Label>Nama lengkap</Label>
            <Input value={fullName} onChange={(event) => setFullName(event.target.value)} maxLength={120} autoComplete="name" required />
          </div>
          {nameMessage && (
            <p className={`text-sm ${nameMessage.tone === 'success' ? 'text-emerald-700' : 'text-red-600'}`} role="status">
              {nameMessage.text}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={nameSaving}>
              <UserRound className="h-4 w-4" />
              {nameSaving ? 'Menyimpan...' : 'Simpan Nama'}
            </Button>
          </div>
        </form>
      </Card>

      <Card className="p-5">
        <div className="mb-5">
          <h2 className="font-semibold text-slate-900">Ubah Password</h2>
          <p className="mt-1 text-sm text-slate-500">Masukkan password saat ini untuk verifikasi. Password baru minimal 6 karakter dan harus berisi huruf serta angka.</p>
        </div>
        <form onSubmit={savePassword} className="space-y-3">
          <div>
            <Label>Password saat ini</Label>
            <Input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required />
          </div>
          <div>
            <Label>Password baru</Label>
            <Input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={6} required />
          </div>
          <div>
            <Label>Konfirmasi password baru</Label>
            <Input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={6} required />
          </div>
          {passwordMessage && (
            <p className={`text-sm ${passwordMessage.tone === 'success' ? 'text-emerald-700' : 'text-red-600'}`} role="status">
              {passwordMessage.text}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={passwordSaving}>
              <KeyRound className="h-4 w-4" />
              {passwordSaving ? 'Memperbarui...' : 'Ubah Password'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
