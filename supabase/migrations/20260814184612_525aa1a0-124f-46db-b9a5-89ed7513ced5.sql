CREATE TABLE public.app_state (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.app_state TO authenticated;
GRANT ALL ON public.app_state TO service_role;

ALTER TABLE public.app_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read app state"
  ON public.app_state FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can create app state"
  ON public.app_state FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update app state"
  ON public.app_state FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_app_state_updated_at BEFORE UPDATE ON public.app_state
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();