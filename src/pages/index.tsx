
import { type GetServerSideProps, type NextPage } from "next";
import { getServerSession, type Session } from "next-auth";
import { useSession } from "next-auth/react";
import HomeSEO from "~/SEO/Home.seo";
import { Anouncement, Header, MainBody } from "~/component";
import { authOptions } from "~/server/auth";
import { api } from "~/utils/api";

const Home: NextPage = () => {
  const { data: session } = useSession();
  const { data } = api.users.subscriptionStatus.useQuery(undefined, {
    enabled: !!session,
    refetchOnWindowFocus: false,
    retry: 0
  });

  return (
    <>
      <HomeSEO />
      <Header />
      {data !== "active" && (
        <div className="w-full bg-light-bg px-0 pt-4 dark:bg-black sm:px-4 lg:hidden lg:pt-0">
          <Anouncement />
        </div>
      )}
      <MainBody />
    </>
  );
};

export default Home;

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);

  return {
    props: {
      session: session
        ? (JSON.parse(JSON.stringify(session)) as Session)
        : null,
    },
  };
};
