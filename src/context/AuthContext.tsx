import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, type Profile } from '@/lib/supabase';

type AuthContextType = {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({
  // Inventory Groups API
  const fetchInventoryGroups = async () => {
    const { data, error } = await supabase.from('inventory_groups').select('*');
    if (error) throw error;
    return data;
  };

  const addInventoryGroup = async (name: string, description: string) => {
    const { data, error } = await supabase.from('inventory_groups').insert({ name, description });
    if (error) throw error;
    return data;
  };

  const updateInventoryGroup = async (id: number, updates: Partial<{ name: string; description: string }>) => {
    const { data, error } = await supabase.from('inventory_groups').update(updates).eq('id', id);
    if (error) throw error;
    return data;
  };

  const deleteInventoryGroup = async (id: number) => {
    const { data, error } = await supabase.from('inventory_groups').delete().eq('id', id);
    if (error) throw error;
    return data;
  };
  // Inventory Groups API
  const fetchInventoryGroups = async () => {
    const { data, error } = await supabase.from('inventory_groups').select('*');
    if (error) throw error;
    return data;
  };

  const addInventoryGroup = async (name: string, description: string) => {
    const { data, error } = await supabase.from('inventory_groups').insert({ name, description });
    if (error) throw error;
    return data;
  };

  const updateInventoryGroup = async (id: number, updates: Partial<{ name: string; description: string }>) => {
    const { data, error } = await supabase.from('inventory_groups').update(updates).eq('id', id);
    if (error) throw error;
    return data;
  };

  const deleteInventoryGroup = async (id: number) => {
    const { data, error } = await supabase.from('inventory_groups').delete().eq('id', id);
    if (error) throw error;
    return data;
  };
  session: null,
  profile: null,
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) {
        loadProfile(data.session.user.id);
      } else {
        setLoading(false);
      }
    });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      if (sess) {
        (async () => {
          await loadProfile(sess.user.id);
        })();
      } else {
        setProfile(null);
        setLoading(false);
      }
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, []);

  async function loadProfile(userId: string) {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    setProfile(data as Profile | null);
    setLoading(false);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setProfile(null);
  }

  return (
    <AuthContext.Provider value={{ session, profile, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
