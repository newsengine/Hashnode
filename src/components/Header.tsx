import { useClickOutside } from "@mantine/hooks";
import Image from "next/image";
import React, { useContext, useState } from "react";
import { C, type ContextValue } from "~/utils/context";
import LeftArea from "./LeftArea";
import NotAuthenticatedProfileDropdown from "./NotAuthenticatedProfileDropdown";
import ProfileDropdown from "./ProfileDropdown";
import RightArea from "./RightAreaHeader";
import SearchArea from "./Search";

const Header: React.FC = () => {
  const [opened, setOpened] = useState(false);
  const ref = useClickOutside<HTMLDivElement>(() => setOpened(false));
  const { user } = useContext(C) as ContextValue;

  return (
    <header className="sticky left-0 top-0 z-50 w-full border-b border-border-light bg-white dark:border-border dark:bg-primary">
      <div className="mx-auto flex max-w-[1550px] items-center justify-between gap-4 px-4 py-4">
        <div className="flex flex-1 items-center justify-between gap-8 md:gap-4">
          <LeftArea />
          <SearchArea />
        </div>

        <div className="flex items-center gap-2">
          <RightArea />
          <button
            aria-label="icon"
            role="button"
            className="relative rounded-full"
            style={{ cursor: "default!important" }}
          >
            <Image
              src={user?.user.profile || "/default_user.avif"}
              alt={user?.user.name || "user"}
              width={100}
              height={100}
              className="h-9 w-9 cursor-pointer select-none overflow-hidden rounded-full"
              onClick={() => setOpened(true)}
              draggable={false}
            />
            {opened &&
              (!!user ? (
                <ProfileDropdown user={user} ref={ref} />
              ) : (
                <NotAuthenticatedProfileDropdown ref={ref} />
              ))}
          </button>
        </div>
      </div>
    </header>
  );
};

export default Header;
